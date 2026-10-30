//! Installed-app discovery and icons: the `discover`, `appIcons` and `browse` requests of the original main process.
//! The discovery script is the original `discover.ps1`, run the same way.
use crate::win;
use base64::{Engine, engine::general_purpose::STANDARD};
use image::{DynamicImage, ImageFormat, imageops::FilterType};
use serde_json::{Map, Value, json};
use std::{collections::HashMap, io::Cursor, path::{Path, PathBuf}, process::Stdio, time::Duration};
use still_core::{domain::allowed_app, js::str_of};
use tokio::{io::AsyncWriteExt, process::Command};

const DISCOVER_SCRIPT: &str = include_str!("../../../native/discover.ps1");
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub fn powershell_exe() -> PathBuf {
    PathBuf::from(std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into())).join(r"System32\WindowsPowerShell\v1.0\powershell.exe")
}

/// Runs a PowerShell script hidden and returns its stdout.
pub async fn powershell(script: &str, limit: Duration, input: Option<String>) -> Result<String, String> {
    // Progress records otherwise leak into stderr as CLIXML; UTF-8 output keeps non-English Windows messages intact.
    let text = format!("$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); {script}");
    let utf16: Vec<u8> = text.encode_utf16().flat_map(u16::to_le_bytes).collect();
    let mut child = Command::new(powershell_exe())
        .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", &STANDARD.encode(utf16)])
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| e.to_string())?;
    if let Some(mut stdin) = child.stdin.take() {
        if let Some(input) = input {
            let _ = stdin.write_all(input.as_bytes()).await;
        }
    }
    let output = tokio::time::timeout(limit, child.wait_with_output()).await.map_err(|_| "Command timed out.".to_string())?.map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

/// Installed apps and Store packages. The native scan finishes in a moment; the original PowerShell script
/// (tens of seconds on a PC with many apps) remains as the fallback if the native scan finds nothing.
pub async fn discover_apps(store_only: bool, executables: &[String]) -> Result<Vec<Value>, String> {
    let extra = executables.to_vec();
    if let Ok(found) = tokio::task::spawn_blocking(move || crate::discover::discover(store_only, &extra)).await {
        if !found.is_empty() {
            return Ok(found.into_iter().take(300).collect());
        }
    }
    discover_with_powershell(store_only, executables).await
}

async fn discover_with_powershell(store_only: bool, executables: &[String]) -> Result<Vec<Value>, String> {
    // Identities go over stdin so large libraries do not exceed Windows' command-line limit.
    let script = format!(
        "[Console]::InputEncoding = [Text.UTF8Encoding]::new($false); & {{ {DISCOVER_SCRIPT}\n }} -StoreOnly:${} -Executables @(ConvertFrom-Json ([Console]::In.ReadToEnd()))",
        if store_only { "true" } else { "false" }
    );
    let stdout = powershell(&script, Duration::from_secs(45), Some(json!(executables).to_string())).await?;
    let parsed: Value = serde_json::from_str(stdout.trim_start_matches('\u{feff}').trim()).map_err(|_| "Could not read the application list. You can still browse for an executable.".to_string())?;
    let list = match parsed {
        Value::Array(list) => list,
        other => vec![other],
    };
    Ok(list.into_iter().take(300).collect())
}

fn png_data_url(image: &DynamicImage) -> Option<String> {
    let mut bytes = Vec::new();
    image.write_to(&mut Cursor::new(&mut bytes), ImageFormat::Png).ok()?;
    Some(format!("data:image/png;base64,{}", STANDARD.encode(bytes)))
}

/// A Store logo scaled so its longer side is 48 px.
fn logo_data_url(bytes: &[u8]) -> Option<String> {
    let image = image::load_from_memory(bytes).ok()?;
    let (w, h) = (image.width().max(1), image.height().max(1));
    let (nw, nh) = if w >= h { (48, (h * 48 / w).max(1)) } else { ((w * 48 / h).max(1), 48) };
    png_data_url(&image.resize_exact(nw, nh, FilterType::Lanczos3))
}

fn shell_icon_data_url(path: &Path) -> Option<String> {
    // Windows hands out 32 px icons for "large" and "normal" and 16 px for "small".
    [32, 16].into_iter().find_map(|size| {
        let (w, h, pixels) = win::file_icon(path, size)?;
        png_data_url(&DynamicImage::ImageRgba8(image::RgbaImage::from_raw(w, h, pixels)?))
    })
}

fn strings(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array).map(|a| a.iter().filter_map(|s| s.as_str().map(String::from)).collect()).unwrap_or_default()
}

/// Adds an icon (and the Store category) to each app. Preferences store identities only, so assets are resolved again here.
pub async fn enrich(apps: &[Value]) -> Vec<Value> {
    let targets: Vec<&Value> = apps.iter().filter(|a| allowed_app(a)).collect();
    let path_of = |a: &Value| str_of(a.get("path")).unwrap_or_default().to_string();
    let needs_assets = targets.iter().any(|a| a.get("iconPaths").is_none() && a.get("iconFiles").is_none());
    let installed = if needs_assets {
        let executables: Vec<String> = targets.iter().map(|a| path_of(a)).filter(|p| !p.starts_with("appx:")).collect();
        discover_apps(false, &executables).await.unwrap_or_default()
    } else {
        Vec::new()
    };
    let sources: HashMap<String, &Value> = installed.iter().map(|a| (path_of(a).to_lowercase(), a)).collect();
    let mut out = Vec::new();
    for target in &targets {
        let mut result: Map<String, Value> = target.as_object().cloned().unwrap_or_default();
        let (icon_paths, icon_files, native_icon) = (result.remove("iconPaths"), result.remove("iconFiles"), result.remove("nativeIcon"));
        result.remove("icon");
        let path = path_of(target);
        let source = sources.get(&path.to_lowercase()).copied();
        let appx = path.starts_with("appx:");
        if appx {
            result.insert("category".into(), json!("Microsoft Store app"));
            let logos = strings(icon_paths.as_ref().or_else(|| source.and_then(|s| s.get("iconPaths"))));
            let found = tokio::task::spawn_blocking(move || logos.iter().find_map(|file| std::fs::read(file).ok().and_then(|bytes| logo_data_url(&bytes)))).await.ok().flatten();
            if let Some(icon) = found {
                result.insert("icon".into(), json!(icon));
                out.push(Value::Object(result));
                continue;
            }
        }
        let native = native_icon.or_else(|| source.and_then(|s| s.get("nativeIcon")).cloned()).filter(|v| !v.is_null() && v != "");
        if let Some(icon) = native {
            result.insert("icon".into(), icon);
            out.push(Value::Object(result));
            continue;
        }
        // Sparse Store registrations can omit artwork that the desktop executable supplies.
        let name = str_of(target.get("name")).unwrap_or_default().to_lowercase();
        let desktop = if appx { targets.iter().copied().chain(installed.iter()).find(|a| !path_of(a).starts_with("appx:") && str_of(a.get("name")).unwrap_or_default().to_lowercase() == name).map(path_of) } else { Some(path.clone()) };
        let mut files = strings(icon_files.as_ref().or_else(|| source.and_then(|s| s.get("iconFiles"))));
        files.extend(desktop);
        let mut seen = std::collections::HashSet::new();
        files.retain(|f| seen.insert(f.clone()));
        let found = tokio::task::spawn_blocking(move || files.iter().filter(|f| Path::new(f).exists()).find_map(|f| shell_icon_data_url(Path::new(f)))).await.ok().flatten();
        if let Some(icon) = found {
            result.insert("icon".into(), json!(icon));
        }
        out.push(Value::Object(result));
    }
    out
}
