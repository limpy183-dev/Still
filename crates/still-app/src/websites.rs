//! Website blocking on the app side (`app/websites-main.cjs`): site logos, the block-screen image,
//! and setting up the Chrome / Edge companion. The companion's own files ship unchanged.
use crate::{
    app::{App, http_get, write_atomic},
    ui::COMPANION,
    win,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use image::{DynamicImage, ImageFormat, codecs::jpeg::JpegEncoder, imageops::FilterType};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{cell::RefCell, collections::HashMap, io::Cursor, path::{Path, PathBuf}, rc::Rc, time::{Duration, SystemTime}};
use still_core::{js::{prop, str_of}, websites};
use tokio::sync::OnceCell;

/// Store-published companion IDs. Add each ID once the store assigns it.
const STORE_IDS: [&str; 1] = ["gkkjcgapilgkjafncmbkgcijnoijgejb"];
const BROWSERS: [&str; 2] = [r"Google\Chrome", r"Microsoft\Edge"];

thread_local! {
    static LOGOS: RefCell<HashMap<String, Rc<OnceCell<String>>>> = RefCell::default();
    static PROFILES: RefCell<HashMap<PathBuf, (SystemTime, bool)>> = RefCell::default();
}

fn png_data_url(image: &DynamicImage) -> Option<String> {
    let mut bytes = Vec::new();
    image.write_to(&mut Cursor::new(&mut bytes), ImageFormat::Png).ok()?;
    Some(format!("data:image/png;base64,{}", STANDARD.encode(bytes)))
}

async fn fetch_logo(app: &Rc<App>, host: String) -> String {
    let file = app.mode.user_data.join("website-icons").join(format!("{host}.png"));
    if let Ok(bytes) = tokio::fs::read(&file).await {
        if image::load_from_memory(&bytes).is_ok() {
            return format!("data:image/png;base64,{}", STANDARD.encode(bytes));
        }
    }
    let url = format!("https://www.google.com/s2/favicons?sz=64&domain={}", urlencode(&host));
    let Ok((status, content_type, body)) = http_get(&url, Duration::from_secs(5), 262_144, "*/*").await else { return String::new() };
    if !(200..300).contains(&status) || !content_type.starts_with("image/") {
        return String::new();
    }
    let small = tokio::task::spawn_blocking(move || {
        let image = image::load_from_memory(&body).ok()?.resize_exact(48, 48, FilterType::CatmullRom);
        let mut png = Vec::new();
        image.write_to(&mut Cursor::new(&mut png), ImageFormat::Png).ok()?;
        Some((png_data_url(&image)?, png))
    })
    .await
    .ok()
    .flatten();
    let Some((uri, png)) = small else { return String::new() };
    if let Some(dir) = file.parent() {
        let _ = tokio::fs::create_dir_all(dir).await;
    }
    let _ = tokio::fs::write(&file, png).await;
    uri
}

fn urlencode(text: &str) -> String {
    text.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}

async fn logo(app: &Rc<App>, target: &Value) -> Result<String, String> {
    if !websites::allowed_website(target) {
        return Err("Invalid website.".into());
    }
    let host = str_of(prop(target, "path")).unwrap_or_default()[8..].to_string();
    let cell = LOGOS.with(|logos| logos.borrow_mut().entry(host.clone()).or_default().clone());
    Ok(cell.get_or_init(|| fetch_logo(app, host)).await.clone())
}

fn with_icon(target: &Value, icon: String) -> Value {
    let mut out = target.as_object().cloned().unwrap_or_default();
    out.insert("icon".into(), json!(icon));
    Value::Object(out)
}

async fn website_image(app: &Rc<App>) -> Result<Value, String> {
    let picked = match app.test_pick() {
        Some(files) => files.into_iter().next(),
        None => rfd::AsyncFileDialog::new().set_title("Choose a website block-screen image").add_filter("Images", &["png", "jpg", "jpeg", "webp"]).set_parent(&win::main_parent()).pick_file().await.map(|f| f.path().to_path_buf()),
    };
    let Some(path) = picked else { return Ok(Value::Null) };
    tokio::task::spawn_blocking(move || {
        if std::fs::metadata(&path).map_err(|e| e.to_string())?.len() > 10 * 1024 * 1024 {
            return Err("Choose an image smaller than 10 MB.".to_string());
        }
        let image = image::load_from_memory(&std::fs::read(&path).map_err(|e| e.to_string())?).map_err(|_| "This image could not be opened. Try a JPG or PNG.".to_string())?;
        let (w, h) = (image.width().max(1), image.height().max(1));
        for max in [1000u32, 750, 500, 320] {
            let (nw, nh) = if w >= h { (w.min(max), (u64::from(h) * u64::from(w.min(max)) / u64::from(w)).max(1) as u32) } else { ((u64::from(w) * u64::from(h.min(max)) / u64::from(h)).max(1) as u32, h.min(max)) };
            let rgb = image.resize_exact(nw, nh, FilterType::Lanczos3).to_rgb8();
            let mut jpeg = Vec::new();
            JpegEncoder::new_with_quality(&mut jpeg, 75).encode_image(&rgb).map_err(|e| e.to_string())?;
            let uri = format!("data:image/jpeg;base64,{}", STANDARD.encode(jpeg));
            if uri.len() <= 180_000 {
                return Ok(json!(uri));
            }
        }
        Err("Choose a smaller image.".to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The unpacked companion's ID, derived from its manifest key the way Chrome derives it.
fn companion_id() -> String {
    let manifest = COMPANION.iter().find(|(name, _)| *name == "manifest.json").map(|(_, bytes)| *bytes).unwrap_or_default();
    let key = serde_json::from_slice::<Value>(manifest).ok().and_then(|m| m["key"].as_str().map(String::from)).unwrap_or_default();
    let hash = Sha256::digest(STANDARD.decode(key).unwrap_or_default());
    hash.iter().take(16).flat_map(|b| [b >> 4, b & 15]).map(|n| (b'a' + n) as char).collect()
}

fn companion_dir(user_data: &Path) -> PathBuf {
    user_data.join("browser-companion")
}

fn guard_exe() -> PathBuf {
    PathBuf::from(std::env::var("ProgramFiles").unwrap_or_else(|_| "C:\\Program Files".into())).join("Still Guard").join("Still.Guard.exe")
}

/// Writes the companion files (and the native-messaging host file) to a stable per-user folder.
fn copy_companion(user_data: &Path, version: &str) -> Result<(), String> {
    let dir = companion_dir(user_data);
    std::fs::create_dir_all(dir.join("icons")).map_err(|e| e.to_string())?;
    let names = ["background.js", "blocked.html", "blocked.css", "blocked.js", "still.html", "still.css", "still.js", "Manrope.woff2", "Manrope-LICENSE.txt", "icons/icon-16.png", "icons/icon-32.png", "icons/icon-48.png", "icons/icon-128.png"];
    let embedded = |name: &str| COMPANION.iter().find(|(n, _)| *n == name).map(|(_, bytes)| *bytes).ok_or_else(|| format!("Missing companion file {name}"));
    let mut files: Vec<(&str, &[u8])> = names.iter().map(|n| embedded(n).map(|b| (*n, b))).collect::<Result<_, _>>()?;
    // The companion loads the shared website rules from the same folder.
    files.push(("websites.js", crate::ui::ui_file("/websites.js").ok_or("Missing websites.js")?));
    for (name, bytes) in &files {
        std::fs::write(dir.join(name), bytes).map_err(|e| e.to_string())?;
    }
    // The manifest goes last: the companion reloads itself once its version_name on disk changes. The fingerprint changes it
    // whenever the files do, even when an installer is rebuilt without a new version.
    let mut hash = Sha256::new();
    files.iter().for_each(|(_, bytes)| hash.update(bytes));
    let fingerprint: String = hash.finalize().iter().take(4).map(|b| format!("{b:02x}")).collect();
    let mut manifest: Value = serde_json::from_slice(embedded("manifest.json")?).map_err(|e| e.to_string())?;
    manifest["version_name"] = json!(format!("{version} ({fingerprint})"));
    write_atomic(&dir.join("manifest.json"), &serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    // Rewritten on every refresh so an update's new store IDs reach users who set up earlier.
    let origins: Vec<String> = std::iter::once(companion_id()).chain(STORE_IDS.iter().map(|s| s.to_string())).map(|id| format!("chrome-extension://{id}/")).collect();
    let host = json!({ "name": "app.still.focus", "description": "Still focus sessions", "path": guard_exe(), "type": "stdio", "allowed_origins": origins });
    std::fs::write(dir.join("native-host.json"), host.to_string()).map_err(|e| e.to_string())
}

/// After an update, brings an already set-up companion up to date without asking the user to set it up again.
pub async fn refresh_companion(app: &Rc<App>) {
    let (user_data, version) = (app.mode.user_data.clone(), app.version());
    if !companion_dir(&user_data).exists() {
        return;
    }
    let result = tokio::task::spawn_blocking(move || copy_companion(&user_data, version)).await;
    if let Ok(Err(error)) = result {
        eprintln!("Browser companion refresh: {error}");
    }
}

fn setup_companion(user_data: &Path, version: &str) -> Result<Value, String> {
    copy_companion(user_data, version)?;
    register_host("Software", &companion_dir(user_data).join("native-host.json"))?;
    Ok(json!({ "directory": companion_dir(user_data), "store": store_url() }))
}

/// Points Chrome and Edge (under `HKCU\<root>`) at the native-messaging host file.
fn register_host(root: &str, host_file: &Path) -> Result<(), String> {
    use winreg::{RegKey, enums::HKEY_CURRENT_USER};
    for browser in BROWSERS {
        let (key, _) = RegKey::predef(HKEY_CURRENT_USER).create_subkey(format!(r"{root}\{browser}\NativeMessagingHosts\app.still.focus")).map_err(|e| e.to_string())?;
        key.set_value("", &host_file.to_string_lossy().as_ref()).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn store_url() -> String {
    format!("https://chromewebstore.google.com/detail/{}", STORE_IDS[0])
}

/// Chrome and Edge list each profile's extensions under `extensions.settings` in (Secure) Preferences.
/// A file is re-read only when it changes, so checking while Settings is open stays cheap.
fn lists_companion(file: &Path) -> bool {
    let Ok(modified) = std::fs::metadata(file).and_then(|m| m.modified()) else { return false };
    if let Some(found) = PROFILES.with(|p| p.borrow().get(file).filter(|(time, _)| *time == modified).map(|(_, found)| *found)) {
        return found;
    }
    let ids: Vec<String> = std::iter::once(companion_id()).chain(STORE_IDS.iter().map(|s| s.to_string())).collect();
    let found = std::fs::read_to_string(file).ok().is_some_and(|text| {
        ids.iter().any(|id| text.contains(id.as_str())) && {
            let settings = serde_json::from_str::<Value>(&text).ok().map(|v| v["extensions"]["settings"].clone()).unwrap_or(Value::Null);
            ids.iter().any(|id| {
                let entry = &settings[id.as_str()];
                !entry.is_null() && match &entry["disable_reasons"] {
                    Value::Array(reasons) => reasons.is_empty(),
                    reasons => !(still_core::js::truthy(Some(reasons)) || entry["state"] == 0),
                }
            })
        }
    });
    PROFILES.with(|p| p.borrow_mut().insert(file.to_path_buf(), (modified, found)));
    found
}

fn extension_installed(local_app_data: &Path) -> bool {
    for browser in BROWSERS {
        let root = local_app_data.join(browser).join("User Data");
        let Ok(entries) = std::fs::read_dir(root) else { continue };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name != "Default" && !name.starts_with("Profile ") {
                continue;
            }
            if ["Secure Preferences", "Preferences"].iter().any(|file| lists_companion(&entry.path().join(file))) {
                return true;
            }
        }
    }
    false
}

pub async fn handle(app: &Rc<App>, name: &str, arg: Value) -> Option<Result<Value, String>> {
    Some(match name {
        "websiteTarget" => async {
            let target = websites::target(arg.as_str().ok_or("Enter a website such as youtube.com or paste its URL.")?)?;
            let icon = logo(app, &target).await?;
            Ok(with_icon(&target, icon))
        }
        .await,
        "websiteIcons" => async {
            let targets = arg.as_array().filter(|t| t.len() <= 300).ok_or("Invalid website list.")?;
            let mut result = Vec::new();
            // Bound concurrent downloads: four at a time.
            for chunk in targets.chunks(4) {
                let icons = futures_util::future::join_all(chunk.iter().map(|t| logo(app, t))).await;
                for (target, icon) in chunk.iter().zip(icons) {
                    result.push(with_icon(target, icon?));
                }
            }
            Ok(Value::Array(result))
        }
        .await,
        "websiteImage" => website_image(app).await,
        "websiteSetup" => {
            let (user_data, version) = (app.mode.user_data.clone(), app.version());
            tokio::task::spawn_blocking(move || setup_companion(&user_data, version)).await.map_err(|e| e.to_string()).and_then(|r| r)
        }
        // The store listing is the main way in; the unpacked folder is the fallback shown under it.
        "websiteStore" => {
            win::open_url(&store_url());
            Ok(Value::Null)
        }
        "websiteExtension" => tokio::task::spawn_blocking(|| json!(extension_installed(&PathBuf::from(std::env::var_os("LOCALAPPDATA").unwrap_or_default())))).await.map_err(|e| e.to_string()),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // website-setup.cjs: the extracted companion, its stable identity, both host registrations (in a throw-away key),
    // the refresh after an update, and the installed-extension check against fake browser profiles.
    #[test]
    fn companion_setup_refresh_and_extension_check() {
        let root = std::env::temp_dir().join(format!("still-companion-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        copy_companion(&root, "1.2.0").unwrap();
        let dir = companion_dir(&root);
        for file in ["background.js", "blocked.html", "blocked.css", "blocked.js", "still.html", "still.css", "still.js", "Manrope.woff2", "manifest.json", "websites.js", "native-host.json", "icons/icon-16.png", "icons/icon-32.png", "icons/icon-48.png", "icons/icon-128.png"] {
            assert!(dir.join(file).exists(), "{file}");
        }
        let host: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("native-host.json")).unwrap()).unwrap();
        let origins: Vec<&str> = host["allowed_origins"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
        let first = origins[0].strip_prefix("chrome-extension://").and_then(|o| o.strip_suffix('/')).unwrap();
        assert!(first.len() == 32 && first.bytes().all(|b| (b'a'..=b'p').contains(&b)), "{first}");
        assert!(origins.contains(&"chrome-extension://gkkjcgapilgkjafncmbkgcijnoijgejb/"), "the store companion may connect");
        assert!(host["path"].as_str().unwrap().ends_with(r"Still Guard\Still.Guard.exe"));
        assert_eq!(host["type"], "stdio");
        assert_eq!(store_url(), "https://chromewebstore.google.com/detail/gkkjcgapilgkjafncmbkgcijnoijgejb");

        // An app update: stale files are refreshed on the next start.
        std::fs::write(dir.join("background.js"), "stale").unwrap();
        std::fs::write(dir.join("manifest.json"), r#"{"version_name":"0.0.1"}"#).unwrap();
        copy_companion(&root, "1.2.0").unwrap();
        assert_ne!(std::fs::read_to_string(dir.join("background.js")).unwrap(), "stale");
        let manifest: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("manifest.json")).unwrap()).unwrap();
        let stamp = manifest["version_name"].as_str().unwrap();
        let print = stamp.strip_prefix("1.2.0 (").and_then(|s| s.strip_suffix(')')).unwrap();
        assert!(print.len() == 8 && print.bytes().all(|b| b.is_ascii_hexdigit()), "{stamp}");
        assert_eq!(manifest["name"], "Still · Website focus");

        let key = format!(r"Software\StillCompanionTests\{}", std::process::id());
        register_host(&key, &dir.join("native-host.json")).unwrap();
        let hkcu = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER);
        for browser in BROWSERS {
            let value: String = hkcu.open_subkey(format!(r"{key}\{browser}\NativeMessagingHosts\app.still.focus")).unwrap().get_value("").unwrap();
            assert_eq!(PathBuf::from(value), dir.join("native-host.json"));
        }
        let _ = hkcu.delete_subkey_all(r"Software\StillCompanionTests");

        let local = root.join("local");
        assert!(!extension_installed(&local), "no browser profiles");
        let prefs = local.join(r"Google\Chrome\User Data\Profile 3\Secure Preferences");
        std::fs::create_dir_all(prefs.parent().unwrap()).unwrap();
        std::fs::write(&prefs, r#"{"extensions":{"settings":{"gkkjcgapilgkjafncmbkgcijnoijgejb":{"disable_reasons":[1]}}}}"#).unwrap();
        assert!(!extension_installed(&local), "a disabled companion does not count");
        std::fs::write(&prefs, r#"{"extensions":{"settings":{"gkkjcgapilgkjafncmbkgcijnoijgejb":{"location":1}}}}"#).unwrap();
        std::fs::File::options().write(true).open(&prefs).unwrap().set_modified(SystemTime::now() + Duration::from_secs(5)).unwrap();
        assert!(extension_installed(&local), "an enabled store companion");
        let _ = std::fs::remove_dir_all(&root);
    }
}
