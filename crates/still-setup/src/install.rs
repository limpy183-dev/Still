//! What Setup does: install, update and uninstall for the current Windows user (the logic of `installer/Setup.cs`).
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::{
    io::{Cursor, Read, Write},
    os::windows::process::CommandExt,
    path::{Path, PathBuf},
    process::Command,
    sync::Mutex,
    time::Duration,
};
use windows::{
    Win32::{
        Foundation::{CloseHandle, HANDLE},
        System::{
            Com::{CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx, CoTaskMemFree, IPersistFile},
            Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS},
            RemoteDesktop::ProcessIdToSessionId,
            Threading::{GetCurrentProcessId, GetExitCodeProcess, OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE, QueryFullProcessImageNameW, TerminateProcess, WaitForSingleObject},
        },
        UI::{
            Shell::{FOLDERID_Desktop, FOLDERID_Programs, IShellLinkW, KF_FLAG_CREATE, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW, SHGetKnownFolderPath, ShellExecuteExW, ShellLink},
            WindowsAndMessaging::SW_HIDE,
        },
    },
    core::{GUID, HSTRING, Interface, PCWSTR, PWSTR},
};
use winreg::{RegKey, enums::{HKEY_CURRENT_USER, KEY_ALL_ACCESS, REG_DWORD}};

const UNINSTALL_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall\Still";
const UNINSTALLER: &str = "Uninstall Still.exe";
const REPOSITORY: &str = "https://github.com/limpy183-dev/Still";
const MAGIC: &[u8; 8] = b"STILLPAY";
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn env(name: &str) -> PathBuf {
    PathBuf::from(std::env::var(name).unwrap_or_default())
}

/// Tests set `STILL_SETUP_SANDBOX` so Setup writes only inside that folder (and a throw-away registry key),
/// never to the real install location, shortcuts, sign-in items or protection service.
fn sandbox() -> Option<PathBuf> {
    std::env::var_os("STILL_SETUP_SANDBOX").map(PathBuf::from)
}

pub fn default_dir() -> PathBuf {
    match sandbox() {
        Some(root) => root.join("Programs").join("Still"),
        None => env("LOCALAPPDATA").join("Programs").join("Still"),
    }
}

fn uninstall_key() -> String {
    match sandbox() {
        Some(root) => format!(r"Software\StillSetupSandbox\{}\Uninstall", root.to_string_lossy().to_lowercase().bytes().fold(5381u32, |h, b| h.wrapping_mul(33) ^ u32::from(b))),
        None => UNINSTALL_KEY.to_string(),
    }
}

fn guard_exe() -> PathBuf {
    match sandbox() {
        Some(root) => root.join("Still Guard").join("Still.Guard.exe"),
        None => env("ProgramFiles").join("Still Guard").join("Still.Guard.exe"),
    }
}

fn known_folder(id: &GUID) -> PathBuf {
    unsafe {
        SHGetKnownFolderPath(id, KF_FLAG_CREATE, None).ok().map(|p| {
            let path = p.to_string().unwrap_or_default();
            CoTaskMemFree(Some(p.0.cast()));
            PathBuf::from(path)
        })
    }
    .unwrap_or_default()
}

/// Same name as the shortcut Still writes for its notification identity, so there is never a duplicate.
fn start_menu_link() -> PathBuf {
    match sandbox() {
        Some(root) => root.join("Start Menu").join("Still Focus.lnk"),
        None => known_folder(&FOLDERID_Programs).join("Still Focus.lnk"),
    }
}

fn desktop_link() -> PathBuf {
    match sandbox() {
        Some(root) => root.join("Desktop").join("Still.lnk"),
        None => known_folder(&FOLDERID_Desktop).join("Still.lnk"),
    }
}

/// The app files, appended to the installer after the program itself.
pub struct Payload {
    pub zip: Vec<u8>,
    /// This program without the payload: it becomes the uninstaller.
    pub program: Vec<u8>,
}

impl Payload {
    pub fn from_self() -> Option<Payload> {
        Payload::parse(std::fs::read(std::env::current_exe().ok()?).ok()?)
    }

    pub fn parse(mut bytes: Vec<u8>) -> Option<Payload> {
        let total = bytes.len();
        let trailer = bytes.get(total.checked_sub(16)?..)?;
        if &trailer[..8] != MAGIC {
            return None;
        }
        let length = u64::from_le_bytes(trailer[8..16].try_into().ok()?) as usize;
        let start = total.checked_sub(16)?.checked_sub(length)?;
        let zip = bytes[start..total - 16].to_vec();
        bytes.truncate(start);
        Some(Payload { zip, program: bytes })
    }

    /// Builds an installer: the program, then the payload, then the trailer that marks it
    /// (`scripts/build.ps1` does the same; this keeps the format under test).
    #[cfg(test)]
    pub fn attach(program: &[u8], zip: &[u8]) -> Vec<u8> {
        let mut out = program.to_vec();
        out.extend_from_slice(zip);
        out.extend_from_slice(MAGIC);
        out.extend_from_slice(&(zip.len() as u64).to_le_bytes());
        out
    }
}

/// Compares dotted versions numerically; anything unparseable falls back to an ordinal comparison.
pub fn compare(a: &str, b: &str) -> std::cmp::Ordering {
    let parse = |v: &str| v.split('.').map(|p| p.parse::<u64>().ok()).collect::<Option<Vec<_>>>().filter(|p| (2..=4).contains(&p.len()));
    match (parse(a), parse(b)) {
        (Some(mut x), Some(mut y)) => {
            let n = x.len().max(y.len());
            x.resize(n, 0);
            y.resize(n, 0);
            x.cmp(&y)
        }
        _ => a.cmp(b),
    }
}

fn is_install_directory(path: &Path) -> bool {
    let norm = |p: &Path| p.to_string_lossy().trim_end_matches('\\').to_lowercase();
    !path.as_os_str().is_empty() && norm(&std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf())) == norm(&default_dir())
}

fn registered() -> (Option<String>, Option<String>) {
    let key = RegKey::predef(HKEY_CURRENT_USER).open_subkey(uninstall_key()).ok();
    let get = |name: &str| key.as_ref().and_then(|k| k.get_value::<String, _>(name).ok());
    (get("InstallLocation"), get("DisplayVersion"))
}

fn retry<T>(mut action: impl FnMut() -> std::io::Result<T>, message: &str) -> Result<T, String> {
    for attempt in 0..=20 {
        match action() {
            Ok(value) => return Ok(value),
            Err(e) if attempt == 20 => return Err(format!("{message} ({e})")),
            Err(_) => std::thread::sleep(Duration::from_millis(300)),
        }
    }
    unreachable!()
}

fn delete_directory(path: &Path) -> Result<(), String> {
    if path.exists() {
        retry(|| std::fs::remove_dir_all(path), "Some of Still's files are in use. Close Still and try again.")?;
    }
    Ok(())
}

fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn powershell_command(script: &str) -> (PathBuf, Vec<String>) {
    let text = format!("$ErrorActionPreference='Stop'; try {{ {script} }} catch {{ exit 1 }}");
    let utf16: Vec<u8> = text.encode_utf16().flat_map(u16::to_le_bytes).collect();
    let exe = env("SystemRoot").join(r"System32\WindowsPowerShell\v1.0\powershell.exe");
    (exe, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand"].map(String::from).into_iter().chain([STANDARD.encode(utf16)]).collect())
}

/// The Still processes of this installation in this Windows session (another user's, or a portable copy, are left alone).
fn still_processes(dir: &Path) -> Vec<(u32, HANDLE)> {
    let mut found = Vec::new();
    let me = std::env::current_exe().ok();
    unsafe {
        let mut session = 0;
        let _ = ProcessIdToSessionId(GetCurrentProcessId(), &mut session);
        let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return found };
        let mut entry = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        let mut more = Process32FirstW(snapshot, &mut entry).is_ok();
        while more {
            let len = entry.szExeFile.iter().position(|c| *c == 0).unwrap_or(entry.szExeFile.len());
            if String::from_utf16_lossy(&entry.szExeFile[..len]).eq_ignore_ascii_case("Still.exe") {
                let pid = entry.th32ProcessID;
                let mut theirs = 0;
                if let (Ok(handle), true) = (OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | PROCESS_SYNCHRONIZE, false, pid), ProcessIdToSessionId(pid, &mut theirs).is_ok() && theirs == session) {
                    let mut buffer = [0u16; 1024];
                    let mut size = buffer.len() as u32;
                    let ours = QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, PWSTR(buffer.as_mut_ptr()), &mut size).is_ok()
                        && PathBuf::from(String::from_utf16_lossy(&buffer[..size as usize])).to_string_lossy().eq_ignore_ascii_case(&dir.join("Still.exe").to_string_lossy());
                    if ours && me.as_deref().is_none_or(|m| m.to_string_lossy().to_lowercase() != dir.join("Still.exe").to_string_lossy().to_lowercase()) {
                        found.push((pid, handle));
                        more = Process32NextW(snapshot, &mut entry).is_ok();
                        continue;
                    }
                    let _ = CloseHandle(handle);
                }
            }
            more = Process32NextW(snapshot, &mut entry).is_ok();
        }
        let _ = CloseHandle(snapshot);
    }
    found
}

fn still_running(dir: &Path) -> bool {
    let processes = still_processes(dir);
    let running = !processes.is_empty();
    for (_, handle) in processes {
        unsafe {
            let _ = CloseHandle(handle);
        }
    }
    running
}

/// Still hides to the tray instead of quitting on close, so it is stopped. Preferences are written atomically.
fn close_still(dir: &Path) {
    for (_, handle) in still_processes(dir) {
        unsafe {
            let _ = TerminateProcess(handle, 1);
            WaitForSingleObject(handle, 10_000);
            let _ = CloseHandle(handle);
        }
    }
}

fn write_shortcut(link: &Path, target: &Path, dir: &Path) -> Result<(), String> {
    if let Some(parent) = link.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let shell: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).map_err(|e| e.to_string())?;
        shell.SetPath(&HSTRING::from(target.as_os_str())).map_err(|e| e.to_string())?;
        shell.SetWorkingDirectory(&HSTRING::from(dir.as_os_str())).map_err(|e| e.to_string())?;
        shell.SetDescription(&HSTRING::from("Still — a space for focus")).map_err(|e| e.to_string())?;
        let file: IPersistFile = shell.cast().map_err(|e| e.to_string())?;
        file.Save(&HSTRING::from(link.as_os_str()), true).map_err(|e| e.to_string())
    }
}

/// Runs a PowerShell script with administrator rights (one UAC prompt) and waits for its exit code.
fn run_elevated_script(script: &str) -> Result<u32, std::io::Error> {
    let (exe, args) = powershell_command(script);
    let wide = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
    let (file, params, verb) = (wide(&exe.to_string_lossy()), wide(&args.join(" ")), wide("runas"));
    unsafe {
        let mut info = SHELLEXECUTEINFOW {
            cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
            fMask: SEE_MASK_NOCLOSEPROCESS,
            lpVerb: PCWSTR(verb.as_ptr()),
            lpFile: PCWSTR(file.as_ptr()),
            lpParameters: PCWSTR(params.as_ptr()),
            nShow: SW_HIDE.0,
            ..Default::default()
        };
        ShellExecuteExW(&mut info).map_err(|e| std::io::Error::from_raw_os_error((e.code().0 & 0xFFFF) as i32))?;
        WaitForSingleObject(info.hProcess, u32::MAX);
        let mut code = 1;
        let _ = GetExitCodeProcess(info.hProcess, &mut code);
        let _ = CloseHandle(info.hProcess);
        Ok(code)
    }
}

fn remove_guard(data: bool) -> Result<(), String> {
    // One administrator prompt: the guard releases its rules and unregisters, then its folders are removed.
    let guard = guard_exe();
    let mut script = format!(
        "$p = Start-Process -FilePath {} -ArgumentList '--uninstall' -Wait -PassThru -WindowStyle Hidden; if ($p.ExitCode -ne 0) {{ exit 1 }}; Remove-Item -LiteralPath {} -Recurse -Force;",
        quote(&guard.to_string_lossy()),
        quote(&guard.parent().unwrap_or(Path::new("")).to_string_lossy())
    );
    if data {
        script += &format!(" Remove-Item -LiteralPath {} -Recurse -Force;", quote(&env("ProgramData").join("Still").to_string_lossy()));
    }
    match run_elevated_script(&script) {
        Ok(0) => Ok(()),
        Ok(_) => Err("Windows protection could not be removed. Finish any active focus session and try again, or switch off \"Remove Windows protection\".".into()),
        Err(e) if e.raw_os_error() == Some(1223) => Err("Windows protection needs administrator approval to be removed. Try again, or switch off \"Remove Windows protection\" to keep it.".into()),
        Err(e) => Err(e.to_string()),
    }
}

/// Unpacks the payload into `target`, reporting progress up to 95%. Returns the unpacked size.
fn extract(zip: &[u8], target: &Path, report: &dyn Fn(&str, f64)) -> Result<u64, String> {
    let mut archive = zip::ZipArchive::new(Cursor::new(zip)).map_err(|e| e.to_string())?;
    let total: u64 = (0..archive.len()).filter_map(|i| archive.by_index(i).ok().map(|e| e.size())).sum();
    std::fs::create_dir_all(target).map_err(|e| e.to_string())?;
    let (mut done, mut shown, mut buffer) = (0u64, -1i64, vec![0u8; 1 << 16]);
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|e| e.to_string())?;
        let relative = entry.enclosed_name().ok_or("Invalid installer archive path.")?;
        let path = target.join(relative);
        if !path.starts_with(target) {
            return Err("Invalid installer archive path.".into());
        }
        if entry.is_dir() {
            std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut output = std::fs::File::create(&path).map_err(|e| e.to_string())?;
        loop {
            let read = entry.read(&mut buffer).map_err(|e| e.to_string())?;
            if read == 0 {
                break;
            }
            output.write_all(&buffer[..read]).map_err(|e| e.to_string())?;
            done += read as u64;
            let percent = (done * 95 / total.max(1)) as i64;
            if percent != shown {
                shown = percent;
                report("Copying Still…", percent as f64);
            }
        }
    }
    Ok(total)
}

/// Replaces the whole folder at once so a failed update leaves the previous version working.
fn swap(staging: &Path, target: &Path) -> Result<(), String> {
    let old = PathBuf::from(format!("{}.old", target.display()));
    delete_directory(&old)?;
    if target.exists() {
        retry(|| std::fs::rename(target, &old), "Still's files are in use. Close Still (including its tray icon) and try again.")?;
    }
    if let Err(e) = std::fs::rename(staging, target) {
        if old.exists() {
            let _ = std::fs::rename(&old, target);
        }
        return Err(e.to_string());
    }
    let _ = delete_directory(&old); // removed on the next update
    Ok(())
}

/// What the page needs to know, plus the choices that later steps depend on.
#[derive(Default)]
struct Chosen {
    dir: PathBuf,
    installed_version: Option<String>,
}

pub struct Ctx {
    payload: Option<Payload>,
    chosen: Mutex<Chosen>,
    remove_folder_on_exit: Mutex<bool>,
}

impl Ctx {
    pub fn new(payload: Option<Payload>) -> Ctx {
        Ctx { payload, chosen: Mutex::default(), remove_folder_on_exit: Mutex::new(false) }
    }

    fn version(&self) -> &'static str {
        env!("CARGO_PKG_VERSION")
    }

    /// Everything the page needs to draw its first screen.
    pub fn state(&self) -> Value {
        let mut chosen = self.chosen.lock().unwrap();
        if self.payload.is_some() {
            let (location, version) = registered();
            let dir = location.map(PathBuf::from).unwrap_or_default();
            if is_install_directory(&dir) && dir.join("Still.exe").exists() {
                chosen.dir = dir;
                chosen.installed_version = version;
            } else {
                chosen.dir = default_dir();
                chosen.installed_version = None;
            }
            let order = chosen.installed_version.as_deref().map_or(0, |old| compare(self.version(), old) as i32);
            return json!({ "uninstaller": false, "version": self.version(), "dir": chosen.dir, "installedVersion": chosen.installed_version, "order": order, "running": still_running(&chosen.dir) });
        }
        let dir = std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf)).unwrap_or_default();
        let (location, _) = registered();
        // Never empty a folder that isn't a Still installation (e.g. the uninstaller copied to Downloads).
        let removable = is_install_directory(&dir) && (dir.join("Still.exe").exists() || location.is_some_and(|l| l.trim_end_matches('\\').eq_ignore_ascii_case(dir.to_string_lossy().trim_end_matches('\\'))));
        chosen.dir = dir;
        json!({ "uninstaller": true, "version": self.version(), "removable": removable, "hasGuard": guard_exe().exists(), "running": removable && still_running(&chosen.dir) })
    }

    pub fn install(&self, desktop: bool, report: &dyn Fn(&str, f64)) -> Result<(), String> {
        let payload = self.payload.as_ref().ok_or("This is not an installer.")?;
        let (dir, update) = {
            let chosen = self.chosen.lock().unwrap();
            (chosen.dir.clone(), chosen.installed_version.is_some())
        };
        report("Closing Still…", 0.0);
        close_still(&dir);
        let staging = PathBuf::from(format!("{}.new", dir.display()));
        delete_directory(&staging)?;
        let size = extract(&payload.zip, &staging, report)?;
        std::fs::write(staging.join(UNINSTALLER), &payload.program).map_err(|e| e.to_string())?;
        report("Putting everything in place…", 96.0);
        swap(&staging, &dir)?;
        register(&dir, size)?;
        let target = dir.join("Still.exe");
        write_shortcut(&start_menu_link(), &target, &dir)?;
        if desktop || (update && desktop_link().exists()) {
            write_shortcut(&desktop_link(), &target, &dir)?;
        }
        report("Done", 100.0);
        Ok(())
    }

    pub fn uninstall(&self, guard: bool, data: bool, report: &dyn Fn(&str, f64)) -> Result<(), String> {
        let dir = self.chosen.lock().unwrap().dir.clone();
        let guard = guard && guard_exe().exists();
        report("Closing Still…", 10.0);
        close_still(&dir);
        if guard {
            report("Removing Windows protection…", 25.0);
            remove_guard(data)?;
        }
        report("Removing shortcuts…", 50.0);
        for link in [start_menu_link(), desktop_link()] {
            if link.exists() {
                std::fs::remove_file(&link).map_err(|e| e.to_string())?;
            }
        }
        // "Open Still when you sign in" entries point at Still.exe in this folder.
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let real_machine = sandbox().is_none();
        if let Some(run) = hkcu.open_subkey_with_flags(r"Software\Microsoft\Windows\CurrentVersion\Run", KEY_ALL_ACCESS).ok().filter(|_| real_machine) {
            let approved = hkcu.open_subkey_with_flags(r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run", KEY_ALL_ACCESS).ok();
            let ours = dir.to_string_lossy().to_lowercase();
            let names: Vec<String> = run.enum_values().flatten().filter(|(_, v)| v.vtype != REG_DWORD && String::from_utf8_lossy(&v.bytes).to_lowercase().replace('\0', "").contains(&ours) || utf16(&v.bytes).to_lowercase().contains(&ours)).map(|(n, _)| n).collect();
            for name in names {
                let _ = run.delete_value(&name);
                if let Some(approved) = &approved {
                    let _ = approved.delete_value(&name);
                }
            }
        }
        // "Alarms after you quit" keeps a scheduled task that reopens Still.exe.
        if real_machine {
            let schtasks = env("SystemRoot").join(r"System32\schtasks.exe");
            let _ = Command::new(schtasks).args(["/Delete", "/TN", "Still Alerts", "/F"]).creation_flags(CREATE_NO_WINDOW).status();
        }
        if data {
            report("Removing your data…", 65.0);
            // Electron named the data folder after package.json "name", and Still keeps using it.
            delete_directory(&sandbox().map_or_else(|| env("APPDATA"), |root| root.join("AppData")).join("still-focus"))?;
            for browser in [r"Google\Chrome", r"Microsoft\Edge"].into_iter().filter(|_| real_machine) {
                let _ = hkcu.delete_subkey_all(format!(r"Software\{browser}\NativeMessagingHosts\app.still.focus"));
            }
        }
        report("Removing Still…", 80.0);
        let me = std::env::current_exe().unwrap_or_default();
        for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
            let path = entry.path();
            if path.to_string_lossy().eq_ignore_ascii_case(&me.to_string_lossy()) {
                continue;
            }
            if path.is_dir() {
                delete_directory(&path)?;
            } else {
                retry(|| std::fs::remove_file(&path), "Some of Still's files are in use. Close Still and try again.")?;
            }
        }
        let _ = hkcu.delete_subkey_all(uninstall_key());
        *self.remove_folder_on_exit.lock().unwrap() = true;
        report("Done", 100.0);
        Ok(())
    }

    pub fn finish(&self, launch: bool) {
        let dir = self.chosen.lock().unwrap().dir.clone();
        if launch {
            let _ = Command::new(dir.join("Still.exe")).current_dir(&dir).spawn();
        }
    }

    /// Waits for this exact process to exit, then deletes its validated installation directory.
    pub fn after_exit(&self) {
        if !*self.remove_folder_on_exit.lock().unwrap() {
            return;
        }
        let dir = self.chosen.lock().unwrap().dir.clone();
        if !is_install_directory(&dir) {
            return;
        }
        let (exe, args) = powershell_command(&format!("Wait-Process -Id {} -ErrorAction SilentlyContinue; Remove-Item -LiteralPath {} -Recurse -Force;", std::process::id(), quote(&dir.to_string_lossy())));
        let _ = Command::new(exe).args(args).creation_flags(CREATE_NO_WINDOW).current_dir(std::env::temp_dir()).spawn();
    }
}

fn utf16(bytes: &[u8]) -> String {
    String::from_utf16_lossy(&bytes.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect::<Vec<_>>()).replace('\0', "")
}

fn register(dir: &Path, size: u64) -> Result<(), String> {
    let (key, _) = RegKey::predef(HKEY_CURRENT_USER).create_subkey(uninstall_key()).map_err(|e| e.to_string())?;
    let version = env!("CARGO_PKG_VERSION");
    let text = |name: &str, value: &str| key.set_value(name, &value).map_err(|e| e.to_string());
    text("DisplayName", "Still")?;
    text("DisplayVersion", version)?;
    text("Publisher", "Still")?;
    text("DisplayIcon", &format!("{},0", dir.join("Still.exe").display()))?;
    text("InstallLocation", &dir.to_string_lossy())?;
    text("UninstallString", &format!("\"{}\"", dir.join(UNINSTALLER).display()))?;
    text("URLInfoAbout", REPOSITORY)?;
    text("URLUpdateInfo", &format!("{REPOSITORY}/releases/latest"))?;
    text("InstallDate", &chrono::Local::now().format("%Y%m%d").to_string())?;
    key.set_value("EstimatedSize", &((size / 1024) as u32)).map_err(|e| e.to_string())?;
    key.set_value("NoModify", &1u32).map_err(|e| e.to_string())?;
    key.set_value("NoRepair", &1u32).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cmp::Ordering::*;

    fn zip_of(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut buffer = Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut buffer);
            for (name, bytes) in files {
                writer.start_file(*name, zip::write::SimpleFileOptions::default()).unwrap();
                writer.write_all(bytes).unwrap();
            }
            writer.finish().unwrap();
        }
        buffer.into_inner()
    }

    #[test]
    fn versions_compare_numerically() {
        assert_eq!(compare("1.2.10", "1.2.9"), Greater);
        assert_eq!(compare("1.2.0", "1.2"), Equal);
        assert_eq!(compare("1.1.9", "1.2.0"), Less);
        assert_eq!(compare("beta", "alpha"), Greater, "unparseable versions compare as text");
    }

    #[test]
    fn the_payload_trailer_round_trips_and_a_plain_program_has_none() {
        let program = b"MZ pretend program".to_vec();
        let zip = zip_of(&[("Still.exe", b"app")]);
        let combined = Payload::attach(&program, &zip);
        let payload = Payload::parse(combined).expect("payload found");
        assert_eq!(payload.program, program);
        assert_eq!(payload.zip, zip);
        assert!(Payload::parse(program).is_none());
        assert!(Payload::parse(vec![]).is_none());
    }

    #[test]
    fn extraction_reports_progress_and_refuses_paths_outside_the_target() {
        let target = std::env::temp_dir().join(format!("Still-setup-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&target);
        let zip = zip_of(&[("Still.exe", &[7u8; 100_000]), ("guard/policy.ps1", b"script")]);
        let seen = std::cell::RefCell::new(Vec::new());
        let size = extract(&zip, &target, &|status, percent| seen.borrow_mut().push((status.to_string(), percent))).unwrap();
        assert_eq!(size, 100_006);
        assert_eq!(std::fs::read(target.join("guard").join("policy.ps1")).unwrap(), b"script");
        assert!(seen.borrow().iter().any(|(s, p)| s == "Copying Still…" && *p >= 90.0));
        let evil = zip_of(&[("../outside.txt", b"x")]);
        assert!(extract(&evil, &target, &|_, _| {}).is_err(), "zip-slip is refused");
        assert!(!target.parent().unwrap().join("outside.txt").exists());
        let _ = std::fs::remove_dir_all(&target);
    }

    #[test]
    fn only_the_default_per_user_folder_counts_as_the_installation() {
        assert!(is_install_directory(&default_dir()));
        assert!(is_install_directory(Path::new(&format!("{}\\", default_dir().display()))));
        assert!(!is_install_directory(Path::new(r"C:\Users\Someone\Downloads")));
        assert!(!is_install_directory(Path::new("")));
    }
}
