//! Windows-only helpers: displays, message boxes, the single-instance lock and the app identity.
use windows::{
    Win32::{
        Foundation::{CloseHandle, ERROR_ALREADY_EXISTS, GetLastError, HANDLE, LPARAM, POINT, RECT, WAIT_OBJECT_0},
        Graphics::Gdi::{EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITOR_DEFAULTTONEAREST, MONITOR_DEFAULTTOPRIMARY, MONITORINFO, MonitorFromPoint},
        System::Threading::{CreateEventW, CreateMutexW, EVENT_MODIFY_STATE, OpenEventW, SetEvent, WaitForSingleObject},
        UI::{
            HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI},
            Shell::SetCurrentProcessExplicitAppUserModelID,
            WindowsAndMessaging::{GetCursorPos, MB_ICONERROR, MB_OK, MessageBoxW},
        },
    },
    core::{BOOL, HSTRING, PCWSTR},
};

/// A rectangle in physical pixels.
#[derive(Clone, Copy, Debug, Default)]
pub struct Area {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

/// One display: its full bounds, its work area (without the taskbar) and its scale factor.
#[derive(Clone, Copy, Debug, Default)]
pub struct Display {
    pub bounds: Area,
    pub work: Area,
    pub scale: f64,
}

fn area(r: RECT) -> Area {
    Area { x: r.left, y: r.top, w: r.right - r.left, h: r.bottom - r.top }
}

fn display(monitor: HMONITOR) -> Display {
    let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
    let (mut dpi_x, mut dpi_y) = (96, 96);
    unsafe {
        let _ = GetMonitorInfoW(monitor, &mut info);
        let _ = GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, &mut dpi_x, &mut dpi_y);
    }
    Display { bounds: area(info.rcMonitor), work: area(info.rcWork), scale: f64::from(dpi_x.max(96)) / 96.0 }
}

pub fn primary_display() -> Display {
    display(unsafe { MonitorFromPoint(POINT::default(), MONITOR_DEFAULTTOPRIMARY) })
}

/// The display under the mouse pointer (Electron's `getDisplayNearestPoint(getCursorScreenPoint())`).
pub fn cursor_display() -> Display {
    let mut point = POINT::default();
    unsafe {
        let _ = GetCursorPos(&mut point);
        display(MonitorFromPoint(point, MONITOR_DEFAULTTONEAREST))
    }
}

pub fn all_displays() -> Vec<Display> {
    unsafe extern "system" fn collect(monitor: HMONITOR, _: HDC, _: *mut RECT, data: LPARAM) -> BOOL {
        unsafe { (*(data.0 as *mut Vec<Display>)).push(display(monitor)) };
        BOOL(1)
    }
    let mut list: Vec<Display> = Vec::new();
    unsafe {
        let _ = EnumDisplayMonitors(None, None, Some(collect), LPARAM(&mut list as *mut _ as isize));
    }
    if list.is_empty() { vec![primary_display()] } else { list }
}

/// Electron's `dialog.showErrorBox`.
pub fn error_box(title: &str, text: &str) {
    unsafe {
        MessageBoxW(None, &HSTRING::from(text), &HSTRING::from(title), MB_OK | MB_ICONERROR);
    }
}

/// Gives toast notifications and the taskbar one stable identity for Still.
pub fn set_app_id(id: &str) {
    unsafe {
        let _ = SetCurrentProcessExplicitAppUserModelID(PCWSTR(HSTRING::from(id).as_ptr()));
    }
}

/// Holds the per-profile lock for as long as it lives (Electron's `requestSingleInstanceLock`).
pub struct InstanceLock(#[allow(dead_code)] isize);

fn names(profile: &str) -> (String, String) {
    use sha2::{Digest, Sha256};
    let hash: String = Sha256::digest(profile.to_lowercase().as_bytes()).iter().take(8).map(|b| format!("{b:02x}")).collect();
    (format!("Local\\Still.Instance.{hash}"), format!("Local\\Still.Show.{hash}"))
}

/// `Some(lock)` for the first instance of this profile; `None` when another one already runs.
pub fn single_instance(profile: &str) -> Option<InstanceLock> {
    let (mutex, _) = names(profile);
    unsafe {
        let handle = CreateMutexW(None, false, &HSTRING::from(mutex)).ok()?;
        if GetLastError() == ERROR_ALREADY_EXISTS {
            let _ = CloseHandle(handle);
            return None;
        }
        Some(InstanceLock(handle.0 as isize))
    }
}

/// Asks the running instance of this profile to show its window.
pub fn signal_first_instance(profile: &str) {
    let (_, event) = names(profile);
    unsafe {
        if let Ok(handle) = OpenEventW(EVENT_MODIFY_STATE, false, &HSTRING::from(event)) {
            let _ = SetEvent(handle);
            let _ = CloseHandle(handle);
        }
    }
}

/// Runs `on_signal` each time a second instance asks this one to show itself.
pub fn listen_for_second_instance(profile: &str, on_signal: impl Fn() + Send + 'static) {
    let (_, event) = names(profile);
    std::thread::spawn(move || unsafe {
        let Ok(handle) = CreateEventW(None, false, false, &HSTRING::from(event)) else { return };
        let handle: HANDLE = handle;
        while WaitForSingleObject(handle, u32::MAX) == WAIT_OBJECT_0 {
            on_signal();
        }
    });
}

// ---- opening things, elevation, identity ----

use std::path::Path;
use windows::Win32::{
    Foundation::GENERIC_READ,
    Security::{Authorization::ConvertSidToStringSidW, GetTokenInformation, TOKEN_QUERY, TOKEN_USER, TokenUser},
    System::Threading::{GetCurrentProcess, GetExitCodeProcess, OpenProcessToken},
    UI::Shell::{SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW, ShellExecuteExW, ShellExecuteW},
    UI::WindowsAndMessaging::{SW_HIDE, SW_SHOWNORMAL},
};

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Opens a URL in the default browser (Electron's `shell.openExternal`).
pub fn open_url(url: &str) {
    unsafe {
        ShellExecuteW(None, &HSTRING::from("open"), &HSTRING::from(url), PCWSTR::null(), PCWSTR::null(), SW_SHOWNORMAL);
    }
}

/// Opens a folder in Explorer (Electron's `shell.openPath`).
pub fn open_path(path: &Path) {
    open_url(&path.to_string_lossy());
}

/// The signed-in user's SID as a string, e.g. `S-1-5-21-…` (passed to Still Guard before it elevates).
pub fn current_user_sid() -> Result<String, String> {
    unsafe {
        let mut token = HANDLE::default();
        OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).map_err(|e| e.to_string())?;
        let mut needed = 0u32;
        let _ = GetTokenInformation(token, TokenUser, None, 0, &mut needed);
        let mut buffer = vec![0u8; needed as usize];
        let result = GetTokenInformation(token, TokenUser, Some(buffer.as_mut_ptr().cast()), needed, &mut needed);
        let _ = CloseHandle(token);
        result.map_err(|e| e.to_string())?;
        let user = &*(buffer.as_ptr() as *const TOKEN_USER);
        let mut text = windows::core::PWSTR::null();
        ConvertSidToStringSidW(user.User.Sid, &mut text).map_err(|e| e.to_string())?;
        let sid = text.to_string().map_err(|e| e.to_string());
        windows::Win32::Foundation::LocalFree(Some(windows::Win32::Foundation::HLOCAL(text.0.cast())));
        sid
    }
}

/// Runs a program with administrator rights (the UAC prompt) and waits; returns its exit code.
pub fn run_elevated(file: &Path, args: &str) -> Result<u32, std::io::Error> {
    let (file, args, verb) = (wide(&file.to_string_lossy()), wide(args), wide("runas"));
    unsafe {
        let mut info = SHELLEXECUTEINFOW {
            cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
            fMask: SEE_MASK_NOCLOSEPROCESS,
            lpVerb: PCWSTR(verb.as_ptr()),
            lpFile: PCWSTR(file.as_ptr()),
            lpParameters: PCWSTR(args.as_ptr()),
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

#[allow(dead_code)]
const _: u32 = GENERIC_READ.0;

// ---- dialogs' parent window, shortcuts ----

use std::sync::atomic::{AtomicIsize, Ordering};
use windows::Win32::{
    Foundation::PROPERTYKEY,
    System::{
        Com::{CLSCTX_INPROC_SERVER, CoCreateInstance, IPersistFile, StructuredStorage::{InitPropVariantFromCLSID, PROPVARIANT}},
        Variant::VT_LPWSTR,
    },
    UI::Shell::{FOLDERID_Programs, IShellLinkW, KF_FLAG_CREATE, SHGetKnownFolderPath, SHStrDupW, ShellLink, PropertiesSystem::IPropertyStore},
};
use windows::core::{GUID, Interface};

/// A string property value (VT_LPWSTR); the string is allocated the way PROPVARIANT's destructor expects.
fn property_string(text: &str) -> windows::core::Result<PROPVARIANT> {
    let mut value = PROPVARIANT::default();
    unsafe {
        let inner = &mut *value.Anonymous.Anonymous;
        inner.vt = VT_LPWSTR;
        inner.Anonymous.pwszVal = SHStrDupW(&HSTRING::from(text))?;
    }
    Ok(value)
}

/// The main window's handle, so file dialogs opened from the logic thread are modal to it.
pub static MAIN_HWND: AtomicIsize = AtomicIsize::new(0);

/// A borrowed window handle that `rfd` accepts as a dialog parent.
pub struct Parent(pub isize);

impl wry::raw_window_handle::HasWindowHandle for Parent {
    fn window_handle(&self) -> Result<wry::raw_window_handle::WindowHandle<'_>, wry::raw_window_handle::HandleError> {
        use wry::raw_window_handle::{RawWindowHandle, Win32WindowHandle, WindowHandle};
        let handle = std::num::NonZeroIsize::new(self.0).ok_or(wry::raw_window_handle::HandleError::Unavailable)?;
        Ok(unsafe { WindowHandle::borrow_raw(RawWindowHandle::Win32(Win32WindowHandle::new(handle))) })
    }
}

impl wry::raw_window_handle::HasDisplayHandle for Parent {
    fn display_handle(&self) -> Result<wry::raw_window_handle::DisplayHandle<'_>, wry::raw_window_handle::HandleError> {
        Ok(wry::raw_window_handle::DisplayHandle::windows())
    }
}

pub fn main_parent() -> Parent {
    Parent(MAIN_HWND.load(Ordering::SeqCst))
}

/// The current user's Start menu Programs folder (it can be redirected, so it is asked for, not assumed).
pub fn programs_folder() -> Option<std::path::PathBuf> {
    unsafe {
        let folder = SHGetKnownFolderPath(&FOLDERID_Programs, KF_FLAG_CREATE, None).ok()?;
        let path = folder.to_string().ok().map(std::path::PathBuf::from);
        windows::Win32::System::Com::CoTaskMemFree(Some(folder.0.cast()));
        path
    }
}

const APP_USER_MODEL: GUID = GUID::from_u128(0x9F4C2855_9F79_4B39_A8D0_E1D42DE1D5F3);

/// Writes a shortcut that also carries the toast identity (AppUserModelID and activator CLSID).
pub fn write_shortcut(link: &Path, target: &Path, description: &str, app_id: &str, activator: GUID) -> windows::core::Result<()> {
    unsafe {
        let shell_link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
        shell_link.SetPath(&HSTRING::from(target.as_os_str()))?;
        if let Some(dir) = target.parent() {
            shell_link.SetWorkingDirectory(&HSTRING::from(dir.as_os_str()))?;
        }
        shell_link.SetDescription(&HSTRING::from(description))?;
        let store: IPropertyStore = shell_link.cast()?;
        let id = property_string(app_id)?;
        store.SetValue(&PROPERTYKEY { fmtid: APP_USER_MODEL, pid: 5 }, &id)?;
        let clsid = InitPropVariantFromCLSID(&activator)?;
        store.SetValue(&PROPERTYKEY { fmtid: APP_USER_MODEL, pid: 26 }, &clsid)?;
        store.Commit()?;
        let file: IPersistFile = shell_link.cast()?;
        file.Save(&HSTRING::from(link.as_os_str()), true)
    }
}

// ---- toast notifications ----

use windows::{
    Data::Xml::Dom::XmlDocument,
    Foundation::TypedEventHandler,
    UI::Notifications::{ToastDismissedEventArgs, ToastFailedEventArgs, ToastNotification, ToastNotificationManager, ToastNotifier},
};

#[derive(Debug)]
pub enum ToastEvent {
    Click,
    Closed,
    Failed(String),
}

/// A shown Windows toast; `hide` removes it.
pub struct Toast {
    notifier: ToastNotifier,
    toast: ToastNotification,
}

impl Toast {
    pub fn hide(&self) {
        let _ = self.notifier.Hide(&self.toast);
    }
}

fn escape_xml(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&apos;")
}

/// Shows a silent toast under Still's app identity and reports clicks, dismissals and failures through `send`.
pub fn show_toast(app_id: &str, title: &str, body: &str, icon: Option<&Path>, silent: bool, send: impl Fn(ToastEvent) + Send + Sync + 'static) -> Result<Toast, String> {
    let send = std::sync::Arc::new(send);
    let logo = icon.map(|p| format!("<image placement=\"appLogoOverride\" src=\"file:///{}\"/>", escape_xml(&p.to_string_lossy().replace('\\', "/")))).unwrap_or_default();
    let text = if body.is_empty() { String::new() } else { format!("<text>{}</text>", escape_xml(body)) };
    let audio = if silent { "<audio silent=\"true\"/>" } else { "" };
    let xml = format!("<toast><visual><binding template=\"ToastGeneric\">{logo}<text>{}</text>{text}</binding></visual>{audio}</toast>", escape_xml(title));
    let fail = |e: windows::core::Error| e.to_string();
    let document = XmlDocument::new().map_err(fail)?;
    document.LoadXml(&HSTRING::from(xml)).map_err(fail)?;
    let toast = ToastNotification::CreateToastNotification(&document).map_err(fail)?;
    let (click, closed, failed) = (send.clone(), send.clone(), send);
    toast.Activated(&TypedEventHandler::new(move |_, _| {
        click(ToastEvent::Click);
        Ok(())
    })).map_err(fail)?;
    toast.Dismissed(&TypedEventHandler::<ToastNotification, ToastDismissedEventArgs>::new(move |_, _| {
        closed(ToastEvent::Closed);
        Ok(())
    })).map_err(fail)?;
    toast.Failed(&TypedEventHandler::<ToastNotification, ToastFailedEventArgs>::new(move |_, args| {
        let code = args.as_ref().and_then(|a| a.ErrorCode().ok()).map(|c| c.0).unwrap_or(0);
        failed(ToastEvent::Failed(format!("0x{code:08X}")));
        Ok(())
    })).map_err(fail)?;
    let notifier = ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(app_id)).map_err(fail)?;
    notifier.Show(&toast).map_err(fail)?;
    Ok(Toast { notifier, toast })
}

// ---- file icons ----

use windows::Win32::{
    Foundation::SIZE,
    Graphics::Gdi::{BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, DeleteObject, GetDC, GetDIBits, ReleaseDC},
    UI::Shell::{IShellItemImageFactory, SHCreateItemFromParsingName, SIIGBF_ICONONLY},
};

/// The shell icon of a file as RGBA pixels (Electron's `app.getFileIcon`).
pub fn file_icon(path: &Path, size: i32) -> Option<(u32, u32, Vec<u8>)> {
    unsafe {
        let factory: IShellItemImageFactory = SHCreateItemFromParsingName(&HSTRING::from(path.as_os_str()), None).ok()?;
        let bitmap = factory.GetImage(SIZE { cx: size, cy: size }, SIIGBF_ICONONLY).ok()?;
        let mut info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER { biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32, biWidth: size, biHeight: -size, biPlanes: 1, biBitCount: 32, biCompression: BI_RGB.0, ..Default::default() },
            ..Default::default()
        };
        let mut pixels = vec![0u8; (size * size * 4) as usize];
        let dc = GetDC(None);
        let rows = GetDIBits(dc, bitmap, 0, size as u32, Some(pixels.as_mut_ptr().cast()), &mut info, DIB_RGB_COLORS);
        ReleaseDC(None, dc);
        let _ = DeleteObject(bitmap.into());
        if rows == 0 {
            return None;
        }
        // BGRA with premultiplied alpha to straight RGBA.
        for px in pixels.chunks_exact_mut(4) {
            let (b, g, r, a) = (px[0], px[1], px[2], px[3]);
            let un = |c: u8| if a == 0 || a == 255 { c } else { ((u32::from(c) * 255 + u32::from(a) / 2) / u32::from(a)).min(255) as u8 };
            px.copy_from_slice(&[un(r), un(g), un(b), a]);
        }
        pixels.chunks_exact(4).any(|p| p[3] != 0).then_some((size as u32, size as u32, pixels))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_signed_in_user_has_a_sid() {
        let sid = current_user_sid().unwrap();
        assert!(sid.starts_with("S-1-5-21-") || sid.starts_with("S-1-12-1-"), "{sid}");
    }

    /// Shows one real toast under a throw-away identity (so it needs a Start menu shortcut and is visible for a moment).
    /// Run on purpose: `cargo test -p still-app --release toast_pipeline -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn toast_pipeline_works_end_to_end() {
        use windows::Win32::System::Com::{COINIT_MULTITHREADED, CoInitializeEx};
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
        let id = "app.still.focus.toasttest";
        let link = programs_folder().expect("a Start menu folder").join("Still toast test.lnk");
        write_shortcut(&link, Path::new(r"C:\Windows\System32\notepad.exe"), "Still toast test", id, GUID::from_u128(0x2BB3B6B9_632E_4618_9488_990BD152DD54)).unwrap();
        std::thread::sleep(std::time::Duration::from_secs(2)); // the shell notices new shortcuts a moment later
        let (sender, receiver) = std::sync::mpsc::channel();
        let shown = show_toast(id, "Still toast test", "This notification checks Still's toast code and goes away on its own.", None, true, move |event| {
            let _ = sender.send(format!("{event:?}"));
        });
        let result = shown.as_ref().map(|toast| {
            let setting = toast.notifier.Setting().map(|s| s.0).ok();
            std::thread::sleep(std::time::Duration::from_secs(3));
            toast.hide();
            (setting, receiver.recv_timeout(std::time::Duration::from_secs(3)).ok())
        });
        let _ = std::fs::remove_file(&link);
        println!("toast result: {:?}", result.as_ref().map_err(|e| e.clone()));
        assert!(shown.is_ok(), "the toast could be created and shown");
        assert_eq!(result.unwrap().0, Some(0), "Windows reports notifications as enabled for the identity (0 = Enabled)");
    }

    #[test]
    fn shell_icons_come_back_as_pixels() {
        let (w, h, pixels) = file_icon(Path::new(r"C:\Windows\System32\notepad.exe"), 32).expect("notepad has an icon");
        assert_eq!((w, h, pixels.len()), (32, 32, 32 * 32 * 4));
        assert!(pixels.chunks_exact(4).any(|p| p[3] > 0));
    }

    #[test]
    fn a_shortcut_with_the_toast_identity_is_written() {
        use windows::Win32::System::Com::{COINIT_APARTMENTTHREADED, CoInitializeEx};
        unsafe {
            let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        }
        let dir = std::env::temp_dir().join(format!("Still-lnk-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let link = dir.join("Still Focus.lnk");
        write_shortcut(&link, Path::new(r"C:\Windows\System32\notepad.exe"), "Still — a space for focus", "app.still.focus", GUID::from_u128(0x2BB3B6B9_632E_4618_9488_990BD152DD54)).unwrap();
        assert!(std::fs::metadata(&link).unwrap().len() > 100);
        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// A string from an executable's version resource (`ProductName`, `FileDescription`, ...). Like .NET's
/// `FileVersionInfo`, it tries the file's own language first, then US English.
pub fn version_string(file: &Path, key: &str) -> Option<String> {
    use windows::Win32::Storage::FileSystem::{FILE_VER_GET_LOCALISED, GetFileVersionInfoExW, GetFileVersionInfoSizeExW, VerQueryValueW};
    unsafe {
        let name = HSTRING::from(file.as_os_str());
        // "Localised" like .NET: the text of many Windows programs lives in their language (.mui) files.
        let mut handle = 0u32;
        let size = GetFileVersionInfoSizeExW(FILE_VER_GET_LOCALISED, &name, &mut handle);
        if size == 0 {
            return None;
        }
        let mut block = vec![0u8; size as usize];
        GetFileVersionInfoExW(FILE_VER_GET_LOCALISED, &name, Some(0), size, block.as_mut_ptr().cast()).ok()?;
        let (mut pointer, mut length) = (std::ptr::null_mut(), 0u32);
        let mut languages = Vec::new();
        if VerQueryValueW(block.as_ptr().cast(), &HSTRING::from("\\VarFileInfo\\Translation"), &mut pointer, &mut length).as_bool() && length >= 4 {
            let pair = std::slice::from_raw_parts(pointer as *const u16, 2);
            languages.push(format!("{:04x}{:04x}", pair[0], pair[1]));
        }
        languages.extend(["040904b0", "040904e4", "04090000"].map(String::from));
        for language in languages {
            let query = HSTRING::from(format!("\\StringFileInfo\\{language}\\{key}"));
            if VerQueryValueW(block.as_ptr().cast(), &query, &mut pointer, &mut length).as_bool() && length > 0 {
                if let Some(text) = PCWSTR(pointer as *const u16).to_string().ok().filter(|s| !s.is_empty()) {
                    return Some(text);
                }
            }
        }
        None
    }
}

/// Whether a path exists, asking only for its attributes (a protected folder such as WindowsApps
/// refuses a full open but still answers this, which is what PowerShell's `Test-Path` relies on).
pub fn path_exists(path: &str) -> bool {
    use windows::Win32::Storage::FileSystem::{GetFileAttributesW, INVALID_FILE_ATTRIBUTES};
    unsafe { GetFileAttributesW(&HSTRING::from(path)) != INVALID_FILE_ATTRIBUTES }
}

/// Whether a path is an existing file (`Test-Path -PathType Leaf`).
pub fn is_file(path: &str) -> bool {
    use windows::Win32::Storage::FileSystem::{FILE_ATTRIBUTE_DIRECTORY, GetFileAttributesW, INVALID_FILE_ATTRIBUTES};
    unsafe {
        let attributes = GetFileAttributesW(&HSTRING::from(path));
        attributes != INVALID_FILE_ATTRIBUTES && attributes & FILE_ATTRIBUTE_DIRECTORY.0 == 0
    }
}