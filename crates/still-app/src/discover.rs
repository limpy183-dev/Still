//! Native port of `native/discover.ps1`: finds the desktop apps and Store packages that can be blocked, with their icons,
//! without starting PowerShell (the script takes tens of seconds on a PC with many apps; this takes a moment).
//! It reads the same places in the same order, applies the same filters and returns the same shape of result.
use crate::win;
use base64::{Engine, engine::general_purpose::STANDARD};
use image::{DynamicImage, ImageFormat};
use regex::Regex;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    io::Cursor,
    path::{Path, PathBuf},
    sync::LazyLock,
};
use windows::{
    ApplicationModel::PackageSignatureKind,
    Management::Deployment::PackageManager,
    Win32::{
        Foundation::{CloseHandle, HWND, LPARAM},
        Graphics::Gdi::{BI_RGB, BITMAP, BITMAPINFO, BITMAPINFOHEADER, DIB_RGB_COLORS, DeleteObject, GetDC, GetDIBits, GetObjectW, HGDIOBJ, ReleaseDC},
        Storage::FileSystem::WIN32_FIND_DATAW,
        System::{
            Com::{CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx, IPersistFile, STGM_READ},
            Threading::{OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW},
        },
        UI::{
            Shell::{ExtractIconExW, FOLDERID_CommonStartMenu, FOLDERID_Desktop, FOLDERID_PublicDesktop, FOLDERID_StartMenu, IShellLinkW, SLGP_RAWPATH, ShellLink},
            WindowsAndMessaging::{DestroyIcon, EnumWindows, GW_OWNER, GetIconInfo, GetWindow, GetWindowThreadProcessId, HICON, ICONINFO, IsWindowVisible},
        },
    },
    core::{HSTRING, Interface, PWSTR},
};
use winreg::{RegKey, enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE}};

static EXCLUDED_NAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)uninstall|setup|update|crash|helper|installer").unwrap());
static PROTECTED_PACKAGE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)Microsoft\.(WindowsStore|DesktopAppInstaller|SecHealthUI|WindowsTerminal)|OpenAI\.Codex").unwrap());
static ICON_INDEX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(.*),\s*(-?\d+)$").unwrap());

#[derive(Default, Clone)]
struct Item {
    name: String,
    path: String,
    icon_files: Vec<String>,
    /// Store packages only: candidate logo files.
    icon_paths: Option<Vec<String>>,
    native_icon: Option<String>,
}

fn windir() -> String {
    std::env::var("WINDIR").unwrap_or_else(|_| "C:\\Windows".into()).to_lowercase()
}

/// `[Environment]::ExpandEnvironmentVariables`.
fn expand_env(text: &str) -> String {
    let mut out = String::new();
    let mut rest = text;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('%').and_then(|end| std::env::var(&after[..end]).ok().map(|v| (end, v))) {
            Some((end, value)) => {
                out.push_str(&value);
                rest = &after[end + 1..];
            }
            None => {
                out.push('%');
                rest = after;
            }
        }
    }
    out + rest
}

fn from_wide(buffer: &[u16]) -> String {
    String::from_utf16_lossy(&buffer[..buffer.iter().position(|c| *c == 0).unwrap_or(buffer.len())])
}

fn stem(path: &str) -> String {
    Path::new(path).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default()
}

/// The collected apps, keyed by lowercase executable path (the script's `Add-App`).
#[derive(Default)]
struct Items {
    order: Vec<String>,
    map: HashMap<String, Item>,
}

impl Items {
    fn add_app(&mut self, name: &str, path: &str, icon_location: Option<&str>) {
        let path = expand_env(path.trim_matches('"'));
        let lower = path.to_lowercase();
        if path.is_empty() || !lower.ends_with(".exe") || !win::path_exists(&path) || lower.starts_with(&windir()) {
            return;
        }
        if !self.map.contains_key(&lower) && !EXCLUDED_NAME.is_match(name) {
            self.order.push(lower.clone());
            self.map.insert(lower.clone(), Item { name: name.to_string(), path: path.clone(), ..Default::default() });
        }
        if let (Some(location), Some(item)) = (icon_location.filter(|l| !l.is_empty()), self.map.get_mut(&lower)) {
            item.icon_files.push(location.to_string());
        }
    }
}

fn known_folder(id: &windows::core::GUID) -> Option<PathBuf> {
    use windows::Win32::{System::Com::CoTaskMemFree, UI::Shell::{KF_FLAG_DEFAULT, SHGetKnownFolderPath}};
    unsafe {
        let folder = SHGetKnownFolderPath(id, KF_FLAG_DEFAULT, None).ok()?;
        let path = folder.to_string().ok().map(PathBuf::from);
        CoTaskMemFree(Some(folder.0.cast()));
        path
    }
}

/// `*.lnk` files under `root`, in the order PowerShell's `Get-ChildItem -Recurse` lists them
/// (a folder's own entries first, then each subfolder, each by name). Folders are listed by several threads at
/// once, and entry types come from the listing itself, so even a Desktop full of project folders is walked quickly.
fn shortcuts_in(root: &Path) -> Vec<PathBuf> {
    use std::sync::{Mutex, atomic::{AtomicUsize, Ordering}};
    let queue = Mutex::new(vec![root.to_path_buf()]);
    let (found, busy) = (Mutex::new(Vec::<PathBuf>::new()), AtomicUsize::new(0));
    let threads = std::thread::available_parallelism().map_or(4, |n| n.get()).clamp(2, 16);
    std::thread::scope(|scope| {
        for _ in 0..threads {
            scope.spawn(|| loop {
                let next = {
                    let mut pending = queue.lock().unwrap();
                    let dir = pending.pop();
                    if dir.is_some() {
                        busy.fetch_add(1, Ordering::SeqCst);
                    }
                    dir
                };
                let Some(dir) = next else {
                    if busy.load(Ordering::SeqCst) == 0 && queue.lock().unwrap().is_empty() {
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_micros(200));
                    continue;
                };
                let (mut links, mut folders) = (Vec::new(), Vec::new());
                for entry in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
                    let Ok(kind) = entry.file_type() else { continue };
                    if kind.is_dir() {
                        folders.push(entry.path());
                    } else if kind.is_file() && entry.path().extension().is_some_and(|e| e.eq_ignore_ascii_case("lnk")) {
                        links.push(entry.path());
                    }
                }
                found.lock().unwrap().extend(links);
                queue.lock().unwrap().extend(folders);
                busy.fetch_sub(1, Ordering::SeqCst);
            });
        }
    });
    // Listing order: at each level a folder's files come before its subfolders, each sorted by name.
    let key = |path: &PathBuf| -> Vec<(u8, String)> {
        let parts: Vec<String> = path.strip_prefix(root).unwrap_or(path).components().map(|c| c.as_os_str().to_string_lossy().to_lowercase()).collect();
        let last = parts.len().saturating_sub(1);
        parts.into_iter().enumerate().map(|(i, name)| (u8::from(i != last), name)).collect()
    };
    let mut list = found.into_inner().unwrap();
    list.sort_by_cached_key(key);
    list
}

/// A shortcut's target and its icon location written as `path,index`.
fn resolve_shortcut(file: &Path) -> Option<(String, String)> {
    unsafe {
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).ok()?;
        let persist: IPersistFile = link.cast().ok()?;
        persist.Load(&HSTRING::from(file.as_os_str()), STGM_READ).ok()?;
        let mut target = [0u16; 1024];
        let mut data = WIN32_FIND_DATAW::default();
        link.GetPath(&mut target, &mut data, SLGP_RAWPATH.0 as u32).ok()?;
        let (mut icon, mut index) = ([0u16; 1024], 0i32);
        link.GetIconLocation(&mut icon, &mut index).ok()?;
        Some((from_wide(&target), format!("{},{index}", from_wide(&icon))))
    }
}

fn each_in_threads<T: Sync, R: Send>(items: &[T], work: impl Fn(&T) -> R + Sync) -> Vec<R> {
    let threads = std::thread::available_parallelism().map_or(4, |n| n.get()).min(8);
    let chunk = items.len().div_ceil(threads).max(1);
    std::thread::scope(|scope| {
        let handles: Vec<_> = items
            .chunks(chunk)
            .map(|part| {
                let work = &work;
                scope.spawn(move || {
                    unsafe {
                        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
                    }
                    part.iter().map(work).collect::<Vec<R>>()
                })
            })
            .collect();
        handles.into_iter().flat_map(|h| h.join().unwrap_or_default()).collect()
    })
}

/// The executables of processes that have a visible, unowned top-level window (PowerShell's `MainWindowHandle -ne 0`).
fn windowed_processes() -> Vec<(String, String)> {
    unsafe extern "system" fn visit(window: HWND, data: LPARAM) -> windows::core::BOOL {
        unsafe {
            if IsWindowVisible(window).as_bool() && GetWindow(window, GW_OWNER).is_err_or_invalid() {
                let mut pid = 0;
                GetWindowThreadProcessId(window, Some(&mut pid));
                (*(data.0 as *mut Vec<u32>)).push(pid);
            }
        }
        windows::core::BOOL(1)
    }
    let mut pids: Vec<u32> = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(visit), LPARAM(&mut pids as *mut _ as isize));
    }
    pids.sort_unstable();
    pids.dedup();
    pids.into_iter()
        .filter_map(|pid| unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
            let mut buffer = [0u16; 1024];
            let mut size = buffer.len() as u32;
            let ok = QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, PWSTR(buffer.as_mut_ptr()), &mut size).is_ok();
            let _ = CloseHandle(handle);
            let path = ok.then(|| String::from_utf16_lossy(&buffer[..size as usize]))?;
            let name = win::version_string(Path::new(&path), "FileDescription").unwrap_or_else(|| stem(&path));
            Some((name, path))
        })
        .collect()
}

trait ValidWindow {
    fn is_err_or_invalid(&self) -> bool;
}
impl ValidWindow for windows::core::Result<HWND> {
    fn is_err_or_invalid(&self) -> bool {
        self.as_ref().map_or(true, |h| h.0.is_null())
    }
}

fn desktop_items(executables: &[String]) -> Items {
    let mut items = Items::default();
    // Start menu and desktop shortcuts.
    let mut files = Vec::new();
    for id in [&FOLDERID_StartMenu, &FOLDERID_CommonStartMenu, &FOLDERID_Desktop, &FOLDERID_PublicDesktop] {
        if let Some(folder) = known_folder(id) {
            files.extend(shortcuts_in(&folder));
        }
    }
    crate::trace(&format!("discover: {} shortcuts listed", files.len()));
    let resolved = each_in_threads(&files, |file| resolve_shortcut(file));
    crate::trace("discover: shortcuts resolved");
    for (file, link) in files.iter().zip(resolved) {
        if let Some((target, icon)) = link {
            items.add_app(&stem(&file.to_string_lossy()), &target, Some(&icon));
        }
    }
    // Registered application paths.
    for (hive, key) in [
        (HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\App Paths"),
        (HKEY_LOCAL_MACHINE, r"Software\Microsoft\Windows\CurrentVersion\App Paths"),
        (HKEY_LOCAL_MACHINE, r"Software\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths"),
    ] {
        let Ok(parent) = RegKey::predef(hive).open_subkey(key) else { continue };
        for name in parent.enum_keys().flatten() {
            // PowerShell expands REG_EXPAND_SZ values such as %ProgramFiles%\...; so must the version lookup.
            let Some(path) = parent.open_subkey(&name).ok().and_then(|k| k.get_value::<String, _>("").ok()).filter(|p| !p.is_empty()).map(|p| expand_env(p.trim_matches('"'))) else { continue };
            let product = win::version_string(Path::new(&path), "ProductName").filter(|p| !p.is_empty());
            items.add_app(&product.unwrap_or_else(|| stem(&path)), &path, None);
        }
    }
    // Apps that are open right now.
    crate::trace("discover: shortcuts added, app paths read");
    for (name, path) in windowed_processes() {
        items.add_app(&name, &path, None);
    }
    crate::trace("discover: running apps read");
    for file in executables {
        items.add_app(&stem(file), file, None);
    }
    items
}

// ---- Store packages ----

/// Candidate logo files for a package, best first (the script's `Get-LogoPaths`).
fn logo_paths(roots: &[PathBuf], logos: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    for root in roots {
        for logo in logos {
            let file = root.join(logo.replace('/', "\\"));
            if win::is_file(&file.to_string_lossy()) {
                out.push(file.to_string_lossy().into_owned());
            }
            // Store manifests often name a logical asset; only qualified files exist on disk.
            let (logo_stem, extension) = (stem(&file.to_string_lossy()), file.extension().map(|e| e.to_string_lossy().to_lowercase()));
            if let Some(dir) = file.parent() {
                let mut variants: Vec<(u8, String, String)> = std::fs::read_dir(dir)
                    .into_iter()
                    .flatten()
                    .flatten()
                    .filter(|e| e.path().is_file())
                    .filter_map(|e| {
                        let name = e.file_name().to_string_lossy().into_owned();
                        let lower = name.to_lowercase();
                        let same = lower.starts_with(&format!("{}.", logo_stem.to_lowercase())) && Path::new(&lower).extension().map(|x| x.to_string_lossy().into_owned()) == extension;
                        let plain = !lower.contains("contrast") && !lower.contains("unplated");
                        let rank = if lower.contains("targetsize-44") || lower.contains("targetsize-48") {
                            if lower.contains("lightunplated") { 0 } else if plain { 1 } else if lower.contains("scale-100") { 2 } else { 4 }
                        } else if lower.contains("scale-100") {
                            2
                        } else if plain {
                            3
                        } else {
                            4
                        };
                        same.then(|| (rank, lower, e.path().to_string_lossy().into_owned()))
                    })
                    .collect();
                variants.sort();
                out.extend(variants.into_iter().take(8).map(|(_, _, path)| path));
            }
            let flat = root.join(Path::new(logo).file_name().unwrap_or_default());
            if win::is_file(&flat.to_string_lossy()) {
                out.push(flat.to_string_lossy().into_owned());
            }
        }
    }
    let mut seen = std::collections::HashSet::new();
    out.retain(|p| seen.insert(p.clone()));
    out
}

fn child<'a, 'input>(node: roxmltree::Node<'a, 'input>, tag: &str) -> Option<roxmltree::Node<'a, 'input>> {
    node.children().find(|c| c.is_element() && c.tag_name().name() == tag)
}

fn store_items() -> Vec<Item> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
    }
    crate::trace("store: start");
    let Ok(manager) = PackageManager::new() else { return Vec::new() };
    let Ok(packages) = manager.FindPackagesByUserSecurityId(&HSTRING::new()) else { return Vec::new() };
    crate::trace("store: packages enumerated");
    let windir = windir();
    let mut by_family: HashMap<String, Item> = HashMap::new();
    let mut order = Vec::new();
    for package in packages {
        let (Ok(id), Ok(location)) = (package.Id(), package.InstalledPath()) else { continue };
        let (name, family) = (id.Name().map(|n| n.to_string()).unwrap_or_default(), id.FamilyName().map(|n| n.to_string()).unwrap_or_default());
        let install = location.to_string();
        if package.IsFramework().unwrap_or(false)
            || package.IsResourcePackage().unwrap_or(false)
            || package.SignatureKind().unwrap_or(PackageSignatureKind::None) == PackageSignatureKind::System
            || install.is_empty()
            || install.to_lowercase().starts_with(&windir)
            || PROTECTED_PACKAGE.is_match(&name)
        {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(Path::new(&install).join("AppxManifest.xml")) else { continue };
        let Ok(manifest) = roxmltree::Document::parse(text.trim_start_matches('\u{feff}')) else { continue };
        let Some(package_node) = manifest.root().children().find(|c| c.is_element() && c.tag_name().name() == "Package") else { continue };
        let applications: Vec<_> = child(package_node, "Applications").map(|a| a.children().filter(|c| c.is_element() && c.tag_name().name() == "Application").collect()).unwrap_or_default();
        if applications.is_empty() {
            continue;
        }
        let properties = child(package_node, "Properties");
        let display = properties.and_then(|p| child(p, "DisplayName")).and_then(|n| n.text()).map(str::trim).filter(|n| !n.is_empty() && !n.to_lowercase().starts_with("ms-resource:")).map(String::from);
        let name = display.unwrap_or_else(|| name.trim_start_matches("Microsoft.").trim_start_matches("MicrosoftCorporationII.").to_string());
        let effective = package.EffectivePath().map(|p| p.to_string()).ok().filter(|p| !p.is_empty());
        let mut roots = vec![PathBuf::from(&install)];
        roots.extend(effective.as_ref().map(PathBuf::from));
        let mut logos: Vec<String> = Vec::new();
        for app in &applications {
            if let Some(visual) = app.descendants().find(|d| d.is_element() && d.tag_name().name() == "VisualElements") {
                for attribute in ["Square44x44Logo", "Square150x150Logo", "Logo"] {
                    logos.extend(visual.attribute(attribute).map(String::from));
                }
            }
        }
        logos.extend(properties.and_then(|p| child(p, "Logo")).and_then(|l| l.text()).map(|t| t.trim().to_string()));
        logos.retain(|l| !l.is_empty());
        let mut seen = std::collections::HashSet::new();
        logos.retain(|l| seen.insert(l.clone()));
        let mut executables: Vec<String> = Vec::new();
        for app in &applications {
            if let Some(executable) = app.attribute("Executable") {
                for root in &roots {
                    let file = root.join(executable.replace('/', "\\"));
                    if win::is_file(&file.to_string_lossy()) {
                        executables.push(file.to_string_lossy().into_owned());
                    }
                }
            }
        }
        let mut seen = std::collections::HashSet::new();
        executables.retain(|e| seen.insert(e.clone()));
        if !by_family.contains_key(&family) {
            order.push(family.clone());
        }
        by_family.insert(family.clone(), Item { name, path: format!("appx:{family}"), icon_files: executables, icon_paths: Some(logo_paths(&roots, &logos)), native_icon: None });
    }
    order.into_iter().filter_map(|f| by_family.remove(&f)).collect()
}

// ---- icons ----

/// A window icon as PNG pixels (Windows' `ExtractIconEx`, then a straight-alpha bitmap).
fn icon_data_url(hicon: HICON) -> Option<String> {
    unsafe {
        let mut info = ICONINFO::default();
        GetIconInfo(hicon, &mut info).ok()?;
        let color = info.hbmColor;
        let mut bitmap = BITMAP::default();
        let described = GetObjectW(HGDIOBJ(color.0), std::mem::size_of::<BITMAP>() as i32, Some(&mut bitmap as *mut _ as *mut _));
        let result = (|| {
            if described == 0 || bitmap.bmWidth <= 0 || bitmap.bmHeight <= 0 {
                return None;
            }
            let (w, h) = (bitmap.bmWidth, bitmap.bmHeight);
            let read = |source: windows::Win32::Graphics::Gdi::HBITMAP| -> Option<Vec<u8>> {
                let mut header = BITMAPINFO { bmiHeader: BITMAPINFOHEADER { biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32, biWidth: w, biHeight: -h, biPlanes: 1, biBitCount: 32, biCompression: BI_RGB.0, ..Default::default() }, ..Default::default() };
                let mut pixels = vec![0u8; (w * h * 4) as usize];
                let dc = GetDC(None);
                let rows = GetDIBits(dc, source, 0, h as u32, Some(pixels.as_mut_ptr().cast()), &mut header, DIB_RGB_COLORS);
                ReleaseDC(None, dc);
                (rows != 0).then_some(pixels)
            };
            let mut pixels = read(color)?;
            // Older icons carry no alpha channel: their transparency lives in the mask bitmap.
            if pixels.chunks_exact(4).all(|p| p[3] == 0) {
                let mask = read(info.hbmMask).unwrap_or_else(|| vec![0; pixels.len()]);
                for (px, m) in pixels.chunks_exact_mut(4).zip(mask.chunks_exact(4)) {
                    px[3] = if m[0] == 0 && m[1] == 0 && m[2] == 0 { 255 } else { 0 };
                }
            }
            for px in pixels.chunks_exact_mut(4) {
                px.swap(0, 2); // BGRA to RGBA
            }
            let image = DynamicImage::ImageRgba8(image::RgbaImage::from_raw(w as u32, h as u32, pixels)?);
            let mut png = Vec::new();
            image.write_to(&mut Cursor::new(&mut png), ImageFormat::Png).ok()?;
            Some(format!("data:image/png;base64,{}", STANDARD.encode(png)))
        })();
        let _ = DeleteObject(HGDIOBJ(color.0));
        let _ = DeleteObject(HGDIOBJ(info.hbmMask.0));
        result
    }
}

/// The first icon that can be extracted from the given locations (`path` or `path,index`).
fn resource_icon(locations: &[String]) -> Option<String> {
    for location in locations {
        let expanded = expand_env(location);
        let (file, index) = match ICON_INDEX.captures(&expanded) {
            Some(c) => (c[1].to_string(), c[2].parse::<i32>().unwrap_or(0)),
            None => (expanded.clone(), 0),
        };
        let file = file.trim().trim_matches('"').to_string();
        if file.is_empty() || !win::is_file(&file) {
            continue;
        }
        unsafe {
            let (mut large, mut small) = (HICON::default(), HICON::default());
            let _ = ExtractIconExW(&HSTRING::from(&file), index, Some(&mut large), Some(&mut small), 1);
            let handle = if large.is_invalid() { small } else { large };
            let url = (!handle.is_invalid()).then(|| icon_data_url(handle)).flatten();
            for icon in [large, small] {
                if !icon.is_invalid() {
                    let _ = DestroyIcon(icon);
                }
            }
            if url.is_some() {
                return url;
            }
        }
    }
    None
}

/// Finds apps and Store packages like `discover.ps1`, sorted by name. `executables` are extra program files to include.
pub fn discover(store_only: bool, executables: &[String]) -> Vec<Value> {
    let (desktop, store) = std::thread::scope(|scope| {
        let store = scope.spawn(store_items);
        let desktop = (!store_only).then(|| scope.spawn(|| desktop_items(executables)));
        (desktop.map(|d| d.join().unwrap_or_default()), store.join().unwrap_or_default())
    });
    crate::trace("discover: desktop and store items collected");
    let mut items: Vec<Item> = desktop.map(|mut d| d.order.iter().filter_map(|k| d.map.remove(k)).collect()).unwrap_or_default();
    items.extend(store);
    // Icons last, for every app (the script's final loop).
    let finished = each_in_threads(&items, |item| {
        let mut locations = item.icon_files.clone();
        if item.icon_paths.is_none() {
            locations.push(item.path.clone());
        }
        let native_icon = resource_icon(&locations);
        let mut seen = std::collections::HashSet::new();
        let files: Vec<String> = locations.into_iter().filter(|l| !l.is_empty() && win::is_file(l) && seen.insert(l.clone())).collect();
        (native_icon, files)
    });
    crate::trace("discover: icons extracted");
    let mut list: Vec<Item> = items
        .into_iter()
        .zip(finished)
        .map(|(mut item, (native_icon, files))| {
            item.native_icon = native_icon;
            item.icon_files = files;
            item
        })
        .collect();
    list.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()).then_with(|| a.path.cmp(&b.path)));
    list.into_iter()
        .map(|item| {
            let mut value = json!({ "name": item.name, "path": item.path, "iconFiles": item.icon_files, "nativeIcon": item.native_icon });
            if let Some(paths) = item.icon_paths {
                value["iconPaths"] = json!(paths);
            }
            value
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn environment_variables_expand_like_dotnet() {
        // Safe here: no other test reads this variable.
        unsafe { std::env::set_var("STILL_TEST_VAR", "C:\\Games") };
        assert_eq!(expand_env("%STILL_TEST_VAR%\\game.exe"), "C:\\Games\\game.exe");
        assert_eq!(expand_env("100%\\x"), "100%\\x");
        assert_eq!(expand_env("%NO_SUCH_VARIABLE_STILL%\\x"), "%NO_SUCH_VARIABLE_STILL%\\x");
    }

    #[test]
    fn app_names_and_locations_are_filtered_like_the_script() {
        let mut items = Items::default();
        items.add_app("Uninstall Thing", r"C:\Windows\System32\notepad.exe", None);
        items.add_app("Notepad", r"C:\Windows\System32\notepad.exe", None); // inside WINDIR: never listed
        assert!(items.map.is_empty());
        let me = std::env::current_exe().unwrap();
        items.add_app("Setup Wizard", &me.to_string_lossy(), None);
        assert!(items.map.is_empty(), "names with setup/update/helper/installer are skipped");
        items.add_app("Still tests", &me.to_string_lossy(), Some(",0"));
        items.add_app("Another name", &me.to_string_lossy().to_uppercase(), Some("x.ico,1"));
        assert_eq!(items.map.len(), 1, "the first name for a path wins, duplicates add icon locations");
        assert_eq!(items.map.values().next().unwrap().icon_files, [",0", "x.ico,1"]);
    }

    #[test]
    fn this_pc_has_apps_with_icons_and_a_store_section() {
        let found = discover(false, &[]);
        assert!(found.len() > 5, "found {}", found.len());
        assert!(found.iter().any(|a| a["nativeIcon"].as_str().is_some_and(|i| i.starts_with("data:image/png;base64,"))));
        let names: Vec<String> = found.iter().map(|a| a["name"].as_str().unwrap_or("").to_lowercase()).collect();
        let mut sorted = names.clone();
        sorted.sort();
        assert_eq!(names, sorted, "sorted by name");
        assert!(found.iter().all(|a| a["path"].as_str().is_some_and(|p| p.starts_with("appx:") || p.to_lowercase().ends_with(".exe"))));
    }
}
