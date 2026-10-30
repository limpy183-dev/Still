//! The Windows side of the guard: AppLocker rules through `policy.ps1`, browser policy in the registry
//! (`native/Websites.cs`), target checks and file protection. The PowerShell script is the original, unchanged.
use crate::guard::Enforcer;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::{
    io::Read,
    os::windows::process::CommandExt,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};
use still_core::{
    domain::PROTECTED_NAMES,
    session::TargetApp,
    websites::domain_of,
};
use winreg::{
    RegKey, RegValue,
    enums::{HKEY_LOCAL_MACHINE, KEY_ALL_ACCESS, REG_DWORD, REG_SZ},
};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const BROWSERS: [&str; 2] = [r"SOFTWARE\Policies\Google\Chrome", r"SOFTWARE\Policies\Microsoft\Edge"];

pub fn system32() -> PathBuf {
    PathBuf::from(std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into())).join("System32")
}

pub fn powershell_exe() -> PathBuf {
    system32().join(r"WindowsPowerShell\v1.0\powershell.exe")
}

/// Runs a program hidden, waiting up to 90 seconds. Returns stdout, or the failure text.
pub fn run(program: &Path, args: &[String]) -> Result<String, String> {
    let mut child = Command::new(program).args(args).creation_flags(CREATE_NO_WINDOW).stdout(Stdio::piped()).stderr(Stdio::piped()).stdin(Stdio::null()).spawn().map_err(|e| e.to_string())?;
    let (mut out, mut err) = (child.stdout.take().unwrap(), child.stderr.take().unwrap());
    let out_reader = std::thread::spawn(move || {
        let mut text = String::new();
        let _ = out.read_to_string(&mut text);
        text
    });
    let err_reader = std::thread::spawn(move || {
        let mut text = String::new();
        let _ = err.read_to_string(&mut text);
        text
    });
    let deadline = Instant::now() + Duration::from_secs(90);
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            break status;
        }
        if Instant::now() > deadline {
            let _ = child.kill();
            return Err("Windows protection timed out. Please try again.".into());
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    let (stdout, stderr) = (out_reader.join().unwrap_or_default(), err_reader.join().unwrap_or_default());
    if status.success() { Ok(stdout) } else { Err(format!("{stderr} {stdout}").trim().to_string()) }
}

/// Runs `policy.ps1` (from `directory`) with an action and an optional payload.
pub fn run_policy(directory: &Path, data: &Path, action: &str, payload: Option<&Value>) -> Result<(), String> {
    let script = directory.join("policy.ps1").to_string_lossy().replace('\'', "''");
    // A long selection would overflow the command line, so the payload travels in a file only SYSTEM and administrators can read.
    let file = data.join("policy-payload.tmp");
    let load = match payload {
        Some(payload) => {
            std::fs::write(&file, STANDARD.encode(payload.to_string())).map_err(|e| e.to_string())?;
            format!("$payload = [IO.File]::ReadAllText('{}');", file.to_string_lossy().replace('\'', "''"))
        }
        None => "$payload = '';".to_string(),
    };
    let command = format!("$ErrorActionPreference='Stop'; try {{ {load} & '{script}' -Action '{action}' -Payload $payload }} catch {{ [Console]::Error.WriteLine($_.Exception.Message); exit 1 }}");
    let utf16: Vec<u8> = command.encode_utf16().flat_map(u16::to_le_bytes).collect();
    let args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand"].map(String::from).into_iter().chain([STANDARD.encode(utf16)]).collect::<Vec<_>>();
    let result = run(&powershell_exe(), &args);
    let _ = std::fs::remove_file(&file);
    result.map(|_| ())
}

fn policy_value_text(value: &RegValue) -> String {
    match value.vtype {
        REG_DWORD => u32::from_le_bytes(value.bytes[..4.min(value.bytes.len())].try_into().unwrap_or([0; 4])).to_string(),
        REG_SZ => {
            let wide: Vec<u16> = value.bytes.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
            String::from_utf16_lossy(&wide).trim_end_matches('\0').to_string()
        }
        _ => String::new(),
    }
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct PolicyValue {
    key: String,
    name: String,
    value: String,
    number: bool,
}

/// Browser policy for website blocks. Only Still-owned values are journaled; existing policies are never overwritten.
/// A registry hive handle. Registry calls are thread-safe, so sharing it between threads is sound.
pub struct Root(pub RegKey);
unsafe impl Send for Root {}
unsafe impl Sync for Root {}
impl std::ops::Deref for Root {
    type Target = RegKey;
    fn deref(&self) -> &RegKey {
        &self.0
    }
}

pub struct WebsitePolicy {
    pub root: Root,
    pub journal: PathBuf,
}

impl WebsitePolicy {
    pub fn local_machine(data: &Path) -> WebsitePolicy {
        WebsitePolicy { root: Root(RegKey::predef(HKEY_LOCAL_MACHINE)), journal: data.join("website-policy.json") }
    }

    fn add_scalar(&self, values: &mut Vec<PolicyValue>, path: &str, name: &str, value: &str) -> Result<(), String> {
        if let Some(existing) = self.root.open_subkey(path).ok().and_then(|key| key.get_raw_value(name).ok()) {
            if policy_value_text(&existing) != value {
                return Err(format!("A browser policy conflicts with website protection: {name}"));
            }
            return Ok(());
        }
        values.push(PolicyValue { key: path.into(), name: name.into(), value: value.into(), number: true });
        Ok(())
    }

    pub fn apply(&self, apps: &[TargetApp]) -> Result<(), String> {
        let mut domains: Vec<String> = Vec::new();
        for app in apps.iter().filter(|a| a.is_website()) {
            let domain = domain_of(app)?;
            if !domains.contains(&domain) {
                domains.push(domain);
            }
        }
        if domains.is_empty() {
            return Ok(());
        }
        if self.journal.exists() {
            return Err("Previous website rules need to be released first.".into());
        }
        let mut values = Vec::new();
        for browser in BROWSERS {
            if self.root.open_subkey(format!(r"{browser}\URLAllowlist")).ok().is_some_and(|k| k.enum_values().count() > 0) {
                return Err("An existing browser allowlist can override website blocks. Still will not change it.".into());
            }
            // Private/guest windows can omit unpacked extensions. Browser policy remains the fallback.
            self.add_scalar(&mut values, browser, if browser.ends_with("Edge") { "InPrivateModeAvailability" } else { "IncognitoModeAvailability" }, "1")?;
            self.add_scalar(&mut values, browser, "BrowserGuestModeEnabled", "0")?;
            let key = self.root.open_subkey(format!(r"{browser}\URLBlocklist")).ok();
            if key.as_ref().is_some_and(|k| k.enum_values().count() + domains.len() + 2 > 1000) {
                return Err("The browser's URL blocklist is full. Still will not replace existing rules.".into());
            }
            // Windows browser policy lists use 1-based indexes. Fill unused slots.
            let mut index = 1;
            for domain in domains.iter().map(String::as_str).chain(["chrome://extensions", "edge://extensions"]) {
                while key.as_ref().is_some_and(|k| k.get_raw_value(index.to_string()).is_ok()) {
                    index += 1;
                }
                values.push(PolicyValue { key: format!(r"{browser}\URLBlocklist"), name: index.to_string(), value: domain.into(), number: false });
                index += 1;
            }
        }
        // Flush the complete undo journal BEFORE changing any policy. Recovery is idempotent.
        {
            use std::io::Write;
            let mut stream = std::fs::OpenOptions::new().write(true).create_new(true).open(&self.journal).map_err(|e| e.to_string())?;
            stream.write_all(serde_json::to_string(&values).map_err(|e| e.to_string())?.as_bytes()).map_err(|e| e.to_string())?;
            stream.sync_all().map_err(|e| e.to_string())?;
        }
        for value in &values {
            let (key, _) = self.root.create_subkey(&value.key).map_err(|e| e.to_string())?;
            if value.number {
                key.set_value(&value.name, &value.value.parse::<u32>().unwrap_or(0)).map_err(|e| e.to_string())?;
            } else {
                key.set_value(&value.name, &value.value).map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    }

    /// Removes only the values Still wrote (and only while they still hold Still's value). Safe to repeat.
    pub fn clear(&self) -> Result<(), String> {
        if !self.journal.exists() {
            return Ok(());
        }
        let values: Vec<PolicyValue> = serde_json::from_str(&std::fs::read_to_string(&self.journal).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        for value in values {
            if let Ok(key) = self.root.open_subkey_with_flags(&value.key, KEY_ALL_ACCESS) {
                if key.get_raw_value(&value.name).is_ok_and(|current| policy_value_text(&current) == value.value) {
                    let _ = key.delete_value(&value.name);
                }
            }
        }
        std::fs::remove_file(&self.journal).map_err(|e| e.to_string())
    }
}

pub struct WindowsEnforcer {
    pub install_dir: PathBuf,
    pub data: PathBuf,
    pub websites: WebsitePolicy,
}

impl WindowsEnforcer {
    pub fn new(install_dir: PathBuf, data: PathBuf) -> WindowsEnforcer {
        WindowsEnforcer { websites: WebsitePolicy::local_machine(&data), install_dir, data }
    }
}

impl Enforcer for WindowsEnforcer {
    fn apply(&self, apps: &[TargetApp], owner: &str) -> Result<(), String> {
        self.websites.apply(apps)?;
        let desktop: Vec<Value> = apps.iter().filter(|a| !a.is_website()).map(|a| json!({ "name": a.name, "path": a.path })).collect();
        if !desktop.is_empty() {
            run_policy(&self.install_dir, &self.data, "apply", Some(&json!({ "owner": owner, "apps": desktop })))?;
        }
        Ok(())
    }

    fn clear(&self) -> Result<(), String> {
        let policy = run_policy(&self.install_dir, &self.data, "clear", None);
        let websites = self.websites.clear();
        policy.and(websites)
    }

    fn validate_target(&self, app: &mut TargetApp) -> Result<(), String> {
        let path = app.path().to_string();
        if path.starts_with("appx:") {
            let family_ok = regex_appx(&path);
            let protected = ["microsoft.windowsstore", "microsoft.desktopappinstaller", "microsoft.sechealthui", "microsoft.windowsterminal", "openai.codex"].iter().any(|p| path.to_lowercase().contains(p));
            if !family_ok || protected {
                return Err("This is a protected Windows package.".into());
            }
            return Ok(()); // Installed package identity and system-package exclusions are checked by policy.ps1.
        }
        let full = std::path::absolute(&path).map_err(|e| e.to_string())?;
        if !full.is_file() {
            return Err(format!("The file no longer exists: {}", full.display()));
        }
        let full_text = full.to_string_lossy().into_owned();
        let lower = full_text.to_lowercase();
        let name = full.file_stem().map(|s| s.to_string_lossy().to_lowercase()).unwrap_or_default();
        let windows = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into()).to_lowercase();
        let install = self.install_dir.to_string_lossy().to_lowercase();
        if PROTECTED_NAMES.contains(&name.as_str()) || name.starts_with("still-") || lower.starts_with(&format!("{windows}\\")) || lower.starts_with(&format!("{install}\\")) || lower.contains("\\windowsapps\\") {
            return Err("Windows components and Still cannot be selected. For Store apps, choose the package from the app picker instead of its .exe file.".into());
        }
        use std::os::windows::fs::MetadataExt;
        if std::fs::symlink_metadata(&full).map_err(|e| e.to_string())?.file_attributes() & 0x400 != 0 {
            return Err("Select the original executable, not a symbolic link.".into());
        }
        if let Some(original) = original_filename(&full) {
            let stem = Path::new(&original).file_stem().map(|s| s.to_string_lossy().to_lowercase()).unwrap_or_default();
            if PROTECTED_NAMES.contains(&stem.as_str()) {
                return Err("This is a protected Windows or Still component.".into());
            }
        }
        let fallback = full.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        app.name = Some(match app.name.as_deref() {
            Some(name) if !name.trim().is_empty() => still_core::js::slice16(name, 100),
            _ => fallback,
        });
        app.path = Some(full_text);
        Ok(())
    }
}

fn regex_appx(path: &str) -> bool {
    let Some(rest) = path.strip_prefix("appx:") else { return false };
    match rest.rsplit_once('_') {
        Some((name, publisher)) => !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_')) && !publisher.is_empty() && publisher.chars().all(|c| c.is_ascii_alphanumeric()),
        None => false,
    }
}

/// The OriginalFilename of an executable's version resource, if it has one.
fn original_filename(file: &Path) -> Option<String> {
    use windows::{
        Win32::Storage::FileSystem::{FILE_VER_GET_LOCALISED, GetFileVersionInfoExW, GetFileVersionInfoSizeExW, VerQueryValueW},
        core::{HSTRING, PCWSTR},
    };
    unsafe {
        let name = HSTRING::from(file.as_os_str());
        let mut handle = 0u32;
        let size = GetFileVersionInfoSizeExW(FILE_VER_GET_LOCALISED, &name, &mut handle);
        if size == 0 {
            return None;
        }
        let mut block = vec![0u8; size as usize];
        GetFileVersionInfoExW(FILE_VER_GET_LOCALISED, &name, Some(0), size, block.as_mut_ptr().cast()).ok()?;
        let (mut pointer, mut length) = (std::ptr::null_mut(), 0u32);
        let translation = if VerQueryValueW(block.as_ptr().cast(), &HSTRING::from("\\VarFileInfo\\Translation"), &mut pointer, &mut length).as_bool() && length >= 4 {
            let pair = std::slice::from_raw_parts(pointer as *const u16, 2);
            format!("{:04x}{:04x}", pair[0], pair[1])
        } else {
            "040904b0".to_string()
        };
        let query = HSTRING::from(format!("\\StringFileInfo\\{translation}\\OriginalFilename"));
        if !VerQueryValueW(block.as_ptr().cast(), &query, &mut pointer, &mut length).as_bool() || length == 0 {
            return None;
        }
        let text = PCWSTR(pointer as *const u16);
        text.to_string().ok().filter(|s| !s.is_empty())
    }
}

/// Swaps `replacement` in for `file`, keeping the old copy as `<file>.bak` (like .NET's `File.Replace`).
pub fn replace_file(file: &Path, replacement: &Path) -> std::io::Result<()> {
    use windows::{Win32::Storage::FileSystem::{REPLACE_FILE_FLAGS, ReplaceFileW}, core::HSTRING};
    let backup = format!("{}.bak", file.display());
    unsafe {
        ReplaceFileW(&HSTRING::from(file.as_os_str()), &HSTRING::from(replacement.as_os_str()), &HSTRING::from(backup), REPLACE_FILE_FLAGS(0), None, None).map_err(|e| std::io::Error::from_raw_os_error((e.code().0 & 0xFFFF) as i32))
    }
}

/// Locks a directory (and the files already in it) to SYSTEM and Administrators, read-only for `read_sid`.
pub fn protect_directory(path: &Path, read_sid: &str) -> Result<(), String> {
    use std::os::windows::fs::MetadataExt;
    std::fs::create_dir_all(path).map_err(|e| e.to_string())?;
    let reparse = |p: &Path| std::fs::symlink_metadata(p).map(|m| m.file_attributes() & 0x400 != 0).unwrap_or(false);
    if reparse(path) {
        return Err(format!("The guard directory must not be a symbolic link or junction: {}", path.display()));
    }
    // FA = full control; 0x1200a9 = read and execute. OICI = inherited by files and folders created later.
    set_security(path, &format!("O:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;{read_sid})"))?;
    for entry in std::fs::read_dir(path).map_err(|e| e.to_string())?.flatten() {
        let file = entry.path();
        if file.is_dir() {
            continue;
        }
        if reparse(&file) {
            return Err("Unexpected symbolic link in the guard directory.".into());
        }
        set_security(&file, &format!("O:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;0x1200a9;;;{read_sid})"))?;
    }
    Ok(())
}

fn set_security(path: &Path, sddl: &str) -> Result<(), String> {
    use windows::{
        Win32::{
            Foundation::{HLOCAL, LocalFree},
            Security::{
                ACL, DACL_SECURITY_INFORMATION, GetSecurityDescriptorDacl, GetSecurityDescriptorOwner, OWNER_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION,
                PSECURITY_DESCRIPTOR, PSID,
                Authorization::{ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1, SE_FILE_OBJECT, SetNamedSecurityInfoW},
            },
        },
        core::{BOOL, HSTRING},
    };
    unsafe {
        let mut descriptor = PSECURITY_DESCRIPTOR::default();
        ConvertStringSecurityDescriptorToSecurityDescriptorW(&HSTRING::from(sddl), SDDL_REVISION_1, &mut descriptor, None).map_err(|e| e.to_string())?;
        let (mut owner, mut defaulted) = (PSID::default(), BOOL(0));
        let (mut present, mut dacl) = (BOOL(0), std::ptr::null_mut::<ACL>());
        let result = GetSecurityDescriptorOwner(descriptor, &mut owner, &mut defaulted)
            .and_then(|()| GetSecurityDescriptorDacl(descriptor, &mut present, &mut dacl, &mut defaulted))
            .map_err(|e| e.to_string())
            .and_then(|()| {
                let status = SetNamedSecurityInfoW(&HSTRING::from(path.as_os_str()), SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION, Some(owner), None, Some(dacl), None);
                if status.0 == 0 { Ok(()) } else { Err(format!("Could not protect {} (error {}).", path.display(), status.0)) }
            });
        let _ = LocalFree(Some(HLOCAL(descriptor.0)));
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sandbox() -> (WebsitePolicy, PathBuf, String) {
        let id = uuid::Uuid::new_v4().to_string();
        let key = format!(r"Software\StillWebsiteTests\{id}");
        let (root, _) = RegKey::predef(winreg::enums::HKEY_CURRENT_USER).create_subkey(&key).unwrap();
        let dir = std::env::temp_dir().join(format!("Still-websites-{id}"));
        std::fs::create_dir_all(&dir).unwrap();
        (WebsitePolicy { root: Root(root), journal: dir.join("journal.json") }, dir, key)
    }
    fn site(host: &str) -> TargetApp {
        TargetApp { name: Some("YouTube".into()), path: Some(format!("website:{host}")) }
    }
    const CHROME: &str = r"SOFTWARE\Policies\Google\Chrome";

    #[test]
    fn browser_policy_preserves_existing_rules_journals_and_cleans_up() {
        let (policy, dir, key) = sandbox();
        let (blocklist, _) = policy.root.create_subkey(format!(r"{CHROME}\URLBlocklist")).unwrap();
        blocklist.set_value("1", &"existing.example.com").unwrap();
        policy.apply(&[site("youtube.com")]).unwrap();
        let list = policy.root.open_subkey(format!(r"{CHROME}\URLBlocklist")).unwrap();
        assert_eq!(list.get_value::<String, _>("1").unwrap(), "existing.example.com", "Existing blocklist preserved");
        assert_eq!(list.get_value::<String, _>("2").unwrap(), "youtube.com", "Domain policy uses contiguous indexes without overwriting values");
        assert!(policy.journal.exists(), "Recovery journal persists");
        policy.clear().unwrap();
        policy.clear().unwrap();
        assert_eq!(policy.root.open_subkey(format!(r"{CHROME}\URLBlocklist")).unwrap().enum_values().count(), 1, "Cleanup removes only Still rules and is idempotent");
        let (allow, _) = policy.root.create_subkey(format!(r"{CHROME}\URLAllowlist")).unwrap();
        allow.set_value("1", &"youtube.com").unwrap();
        assert!(policy.apply(&[site("youtube.com")]).is_err(), "Existing allowlist rejected before mutation");
        assert!(!policy.journal.exists(), "Conflict does not create undo state");
        policy.root.delete_subkey_all(format!(r"{CHROME}\URLAllowlist")).unwrap();
        let (chrome, _) = policy.root.create_subkey(CHROME).unwrap();
        chrome.set_value("BrowserGuestModeEnabled", &1u32).unwrap();
        assert!(policy.apply(&[site("youtube.com")]).is_err(), "Conflicting private/guest policy rejected");
        let _ = RegKey::predef(winreg::enums::HKEY_CURRENT_USER).delete_subkey_all(key);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn websites_are_checked_before_anything_changes() {
        let (policy, dir, key) = sandbox();
        for host in ["localhost", "127.0.0.1", "example.com\n", "*.example.com", "WWW.example.com", "a..com", "a.local"] {
            assert!(policy.apply(&[site(host)]).is_err(), "Reject unsafe domain {host}");
        }
        assert!(!policy.journal.exists());
        let _ = RegKey::predef(winreg::enums::HKEY_CURRENT_USER).delete_subkey_all(key);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn desktop_targets_are_vetted() {
        let enforcer = WindowsEnforcer::new(PathBuf::from(r"C:\Program Files\Still Guard"), std::env::temp_dir());
        let mut notepad = TargetApp { name: Some("Notepad".into()), path: Some(r"C:\Windows\System32\notepad.exe".into()) };
        assert!(enforcer.validate_target(&mut notepad).is_err(), "Windows components cannot be selected");
        let mut missing = TargetApp { name: None, path: Some(r"C:\definitely\missing\app.exe".into()) };
        assert!(enforcer.validate_target(&mut missing).unwrap_err().contains("no longer exists"));
        let mut appx = TargetApp { name: None, path: Some("appx:Microsoft.WindowsStore_8wekyb3d8bbwe".into()) };
        assert!(enforcer.validate_target(&mut appx).is_err());
        let mut fine = TargetApp { name: None, path: Some("appx:SpotifyAB.SpotifyMusic_zpdnekdrzrea0".into()) };
        assert!(enforcer.validate_target(&mut fine).is_ok());
    }
}
