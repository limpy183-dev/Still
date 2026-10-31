//! The window layer: tao event loop, WebView2 windows, the tray icon, the embedded-assets protocol and the JS bridge.
//! It plays the role of Electron's BrowserWindow, preload scripts, Tray and protocol handlers.
use crate::win::{self, Area};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    borrow::Cow,
    collections::HashMap,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::{Arc, atomic::{AtomicBool, Ordering}},
};
use still_core::{alerts::MEDIA_FILE, domain::same_page_url};
use tao::{
    dpi::{LogicalSize, PhysicalPosition, PhysicalSize},
    event::{Event, WindowEvent},
    event_loop::{ControlFlow, EventLoop, EventLoopProxy, EventLoopWindowTarget},
    platform::{
        run_return::EventLoopExtRunReturn,
        windows::{IconExtWindows, WindowBuilderExtWindows, WindowExtWindows},
    },
    window::{Fullscreen, Icon, Window, WindowBuilder, WindowId},
};
use tokio::sync::mpsc::UnboundedSender;
use tray_icon::{
    TrayIcon, TrayIconBuilder, TrayIconEvent,
    menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem},
};
use windows::Win32::{
    Foundation::HWND,
    UI::WindowsAndMessaging::{GetSystemMetrics, GetWindowPlacement, SM_CXSMICON, SW_HIDE, SW_SHOWMAXIMIZED, SW_SHOWNOACTIVATE, SetWindowPlacement, ShowWindow, WINDOWPLACEMENT},
};
use wry::{
    NewWindowResponse, PermissionResponse, RequestAsyncResponder, WebContext, WebView, WebViewBuilder, WebViewBuilderExtWindows,
    http::{Request, Response, header},
};

mod embedded {
    include!(concat!(env!("OUT_DIR"), "/embedded.rs"));
}
pub use embedded::COMPANION;

/// A file of the embedded UI by URL path, e.g. `/websites.js`.
pub fn ui_file(url: &str) -> Option<&'static [u8]> {
    embedded::FILES.iter().find(|(u, _)| *u == url).map(|(_, bytes)| *bytes)
}

pub const APP_URL: &str = "https://still.localhost/index.html";
pub const ALARM_URL: &str = "https://still.localhost/alarm.html";
pub const APP_TITLE: &str = "Still — Your time, on purpose";

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum WindowKey {
    Main,
    Alarm(u64),
}

/// One alarm window (a full-screen alarm opens one per display).
#[derive(Clone, Debug)]
pub struct AlarmWindow {
    pub id: u64,
    pub area: Area,
    pub full: bool,
    pub on_top: bool,
}

/// Messages from the UI thread to the app logic.
pub enum CoreMsg {
    Invoke { from: WindowKey, id: u64, name: String, args: Vec<Value> },
    AlarmReady(u64),
    AlarmClosed(u64),
    Toast(u64, crate::win::ToastEvent),
    Quit,
}

/// Requests to the UI thread (callable from any thread through the proxy).
pub enum UiEvent {
    Eval(WindowKey, String),
    ShowMain,
    OpenAlarm(AlarmWindow),
    ShowAlarm(u64),
    CloseAlarm(u64),
    QuitLabel(String),
    /// A hide timer ran out: release the main window's web engine if the window is still in the tray (the number says which hide).
    ReleaseMain(u64),
    Call { from: WindowKey, uri: String, call: Call },
    Tray(TrayIconEvent),
    Menu(String),
    Exit,
}

#[derive(Deserialize)]
pub struct Call {
    pub id: Option<u64>,
    pub name: String,
    #[serde(default)]
    pub args: Vec<Value>,
}

pub type Ui = EventLoopProxy<UiEvent>;

pub struct UiConfig {
    pub web_data: PathBuf,
    pub media_dir: PathBuf,
    pub start_hidden: Arc<AtomicBool>,
    pub core: UnboundedSender<CoreMsg>,
    pub quit_label: String,
    /// `--test` runs may ask for a report of the native windows (the original tests inspected them from Electron).
    pub testing: bool,
    /// How long the main window may sit in the tray before its web engine (about 170 MB of browser processes) is released;
    /// opening Still again starts a new one. `None` keeps it for as long as Still runs.
    pub release_after: Option<std::time::Duration>,
}

pub fn reply_script(id: u64, result: &Result<Value, String>) -> String {
    match result {
        Ok(value) => format!("window.__still.reply({id},true,{value})"),
        Err(message) => format!("window.__still.reply({id},false,{})", Value::String(message.clone())),
    }
}

pub fn emit_script(channel: &str, value: &Value) -> String {
    format!("window.__still.emit({},{value})", Value::String(channel.into()))
}

const BRIDGE: &str = r#"(() => {
  const pending = new Map(), listeners = Object.create(null);
  let seq = 0;
  const post = message => window.ipc.postMessage(JSON.stringify(message));
  Object.defineProperty(window, '__still', { value: Object.freeze({
    reply(id, ok, value) { const call = pending.get(id); if (!call) return; pending.delete(id); ok ? call.resolve(value) : call.reject(new Error(value)); },
    emit(channel, value) { for (const callback of [...(listeners[channel] || [])]) { try { callback(value); } catch (error) { console.error(error); } } }
  }) });
  const invoke = name => (...args) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); post({ id, name, args }); });
  const on = channel => callback => { (listeners[channel] ||= new Set()).add(callback); return () => listeners[channel].delete(callback); };
  const setZoom = factor => { if (Number.isFinite(factor)) post({ name: 'setZoom', args: [Math.min(1.75, Math.max(1, factor))] }); };
  // Electron ran the screens with spellcheck off; WebView2 underlines misspellings unless an ancestor says otherwise.
  addEventListener('DOMContentLoaded', () => { document.documentElement.spellcheck = false; });
  // Electron's default menu kept its shortcuts in these frameless windows (after the page had its turn); WebView2 has none.
  const shortcuts = { 'F11': 'togglefullscreen', 'Ctrl+w': 'close', 'Ctrl+m': 'minimize', 'Ctrl+r': 'reload', 'Ctrl+Shift+r': 'forceReload', 'Ctrl+Shift+i': 'toggleDevTools', 'Ctrl+0': 'resetZoom', 'Ctrl++': 'zoomIn', 'Ctrl+Shift++': 'zoomIn', 'Ctrl+-': 'zoomOut' };
  addEventListener('keydown', event => {
    if (event.defaultPrevented || event.altKey || event.metaKey) return;
    const action = shortcuts[(event.ctrlKey ? 'Ctrl+' : '') + (event.shiftKey ? 'Shift+' : '') + (event.key.length === 1 ? event.key.toLowerCase() : event.key)];
    if (action) { event.preventDefault(); post({ name: 'accelerator', args: [action] }); }
  });
  __EXPOSE__
})();"#;

const MAIN_API: &str = r#"window.still = Object.freeze({
    websiteTarget: invoke('websiteTarget'), websiteIcons: invoke('websiteIcons'), websiteImage: invoke('websiteImage'), websiteSetup: invoke('websiteSetup'), websiteStore: invoke('websiteStore'), websiteExtension: invoke('websiteExtension'),
    setZoom,
    bootstrap: invoke('bootstrap'), appIcons: invoke('appIcons'), showWindow: invoke('showWindow'), status: invoke('status'), savePreferences: invoke('savePreferences'),
    install: invoke('install'), uninstall: invoke('uninstall'), discover: invoke('discover'), browse: invoke('browse'),
    start: invoke('start'), requestUnlock: invoke('requestUnlock'), cancelUnlock: invoke('cancelUnlock'), end: invoke('end'),
    window: invoke('window'), exportHistory: invoke('exportHistory'), checkForUpdates: invoke('checkForUpdates'), downloadUpdate: invoke('downloadUpdate'), updateHistory: invoke('updateHistory'),
    listAlerts: invoke('alerts:list'), saveAlert: invoke('alerts:save'), deleteAlert: invoke('alerts:delete'), toggleAlert: invoke('alerts:toggle'), previewAlert: invoke('alerts:preview'), pickAlertMedia: invoke('alerts:media'), folderSounds: invoke('alerts:folderSounds'), folderSound: invoke('alerts:folderSound'), openSoundsFolder: invoke('alerts:openSoundsFolder'),
    onAlerts: on('alerts-changed'), onAlertError: on('alert-error'), onPresentation: on('presentation-visible'), onStatus: on('guard-status')
  });"#;

const ALARM_API: &str = r#"window.alarm = Object.freeze({
    setZoom,
    action: invoke('alarm-action'),
    onData: callback => { on('alarm-data')(callback); post({ name: 'alarm-ready' }); },
    onMessage: on('alarm-message')
  });"#;

fn mime(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("").to_ascii_lowercase().as_str() {
        "html" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "json" => "application/json",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "svg" => "image/svg+xml",
        "woff2" => "font/woff2",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "m4a" => "audio/mp4",
        "aac" => "audio/aac",
        "flac" => "audio/flac",
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        _ => "text/plain; charset=utf-8",
    }
}

fn respond(status: u16, content_type: &str, body: impl Into<Cow<'static, [u8]>>) -> Response<Cow<'static, [u8]>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CACHE_CONTROL, "no-cache")
        .header("X-Content-Type-Options", "nosniff")
        .body(body.into())
        .expect("static response headers are valid")
}

/// Serves an imported alert media file, honouring `Range` so audio and video can seek.
fn serve_media(dir: &Path, name: &str, range: Option<&str>) -> Response<Cow<'static, [u8]>> {
    const CHUNK: u64 = 4 * 1024 * 1024;
    let not_found = || respond(404, "text/plain", &b"Not found"[..]);
    if !MEDIA_FILE.is_match(name) {
        return not_found();
    }
    let Ok(mut file) = std::fs::File::open(dir.join(name)) else { return not_found() };
    let Ok(total) = file.metadata().map(|m| m.len()) else { return not_found() };
    let (start, end, partial) = match range.and_then(|r| r.strip_prefix("bytes=")).and_then(|r| r.split_once('-')) {
        Some((from, to)) if total > 0 => {
            let (start, wanted) = match (from.parse::<u64>(), to.parse::<u64>()) {
                (Ok(s), Ok(e)) => (s, e),
                (Ok(s), Err(_)) => (s, u64::MAX),
                (Err(_), Ok(n)) => (total.saturating_sub(n), u64::MAX),
                _ => (0, u64::MAX),
            };
            if start >= total {
                return Response::builder().status(416).header(header::CONTENT_RANGE, format!("bytes */{total}")).body(Cow::Borrowed(&b""[..])).unwrap();
            }
            (start, wanted.min(total - 1).min(start + CHUNK - 1), true)
        }
        _ => (0, total.saturating_sub(1), false),
    };
    let mut body = vec![0; if total == 0 { 0 } else { (end - start + 1) as usize }];
    if file.seek(SeekFrom::Start(start)).and_then(|_| file.read_exact(&mut body)).is_err() {
        return not_found();
    }
    let mut response = Response::builder()
        .status(if partial { 206 } else { 200 })
        .header(header::CONTENT_TYPE, mime(name))
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CACHE_CONTROL, "no-cache")
        .header("X-Content-Type-Options", "nosniff");
    if partial {
        response = response.header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{total}"));
    }
    response.body(Cow::Owned(body)).expect("static response headers are valid")
}

fn serve(media_dir: &Path, request: &Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
    crate::trace(&format!("GET {}", request.uri().path()));
    if !matches!(request.method().as_str(), "GET" | "HEAD") {
        return respond(405, "text/plain", &b"Method not allowed"[..]);
    }
    let path = request.uri().path();
    if let Some(name) = path.strip_prefix("/media/") {
        let range = request.headers().get(header::RANGE).and_then(|v| v.to_str().ok());
        return serve_media(media_dir, name, range);
    }
    let path = match path {
        "/" => "/index.html",
        // WebView2 asks for a favicon that the old file:// page never did.
        "/favicon.ico" => "/assets/still.ico",
        other => other,
    };
    match embedded::FILES.iter().find(|(url, _)| *url == path) {
        Some((url, bytes)) => respond(200, mime(url), Cow::Borrowed(*bytes)),
        None => respond(404, "text/plain", &b"Not found"[..]),
    }
}

struct Entry {
    window: Window,
    webview: WebView,
    spec: Option<AlarmWindow>,
}

struct Ui_<'a> {
    cfg: &'a UiConfig,
    proxy: Ui,
    web_context: WebContext,
    /// Where the main window was (and whether it was maximized) when its web engine was released: Electron kept its
    /// window, so a window moved, resized or maximized by the user comes back the same way.
    main_placement: Option<(WINDOWPLACEMENT, bool)>,
    show_maximized: bool,
}

impl Ui_<'_> {
    fn webview(&mut self, window: &Window, key: WindowKey) -> Result<WebView, String> {
        let (page, api, background) = match key {
            WindowKey::Main => (APP_URL, MAIN_API, (246, 247, 242, 255)),
            WindowKey::Alarm(_) => (ALARM_URL, ALARM_API, (245, 246, 241, 255)),
        };
        let (proxy, media) = (self.proxy.clone(), self.cfg.media_dir.clone());
        let testing = self.cfg.testing;
        let builder = WebViewBuilder::new_with_web_context(&mut self.web_context)
            .with_background_color(background)
            .with_url(page)
            .with_initialization_script(BRIDGE.replace("__EXPOSE__", api))
            .with_asynchronous_custom_protocol("still".into(), move |_, request, responder: RequestAsyncResponder| {
                let media = media.clone();
                std::thread::spawn(move || responder.respond(serve(&media, &request)));
            })
            .with_ipc_handler(move |request| {
                let uri = request.uri().to_string();
                if let Ok(call) = serde_json::from_str::<Call>(request.body()) {
                    let _ = proxy.send_event(UiEvent::Call { from: key, uri, call });
                }
            })
            // The page never navigates, opens windows or asks for browser permissions.
            .with_navigation_handler(move |url| url == page)
            .with_new_window_req_handler(|_, _| NewWindowResponse::Deny)
            .with_permission_handler(|_| PermissionResponse::Deny)
            // Opened only by Ctrl+Shift+I, as in Electron (the browser's own F12 stays off with its other accelerators).
            .with_devtools(true)
            .with_hotkeys_zoom(false)
            .with_browser_accelerator_keys(false)
            .with_default_context_menus(false)
            // Electron has no form autofill; WebView2 would suggest earlier entries (alert titles, website addresses).
            .with_general_autofill_enabled(false)
            .with_autoplay(true)
            .with_https_scheme(true);
        // Tests attach Playwright through WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS (--remote-debugging-port). Some WebView2
        // runtimes (the hosted CI runner's) drop that variable when the app passes its own arguments, so pass it explicitly
        // next to wry's defaults.
        let builder = match std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS") {
            Ok(extra) if testing => builder.with_additional_browser_args(format!(
                "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required {extra}"
            )),
            _ => builder,
        };
        builder.build(window).map_err(|e| e.to_string())
    }
}

/// Electron places a frameless window by its content; tao positions it by the invisible resize border around it.
fn place_content(window: &Window, x: i32, y: i32) {
    if let (Ok(inner), Ok(outer)) = (window.inner_position(), window.outer_position()) {
        window.set_outer_position(PhysicalPosition::new(x - (inner.x - outer.x), y - (inner.y - outer.y)));
    }
}

fn icon(size: u32) -> Option<Icon> {
    Icon::from_resource(1, Some(PhysicalSize::new(size, size))).ok()
}

/// The main window: frameless like Electron's `frame: false`, sized to the work area, hidden until the page asks.
fn create_main(target: &EventLoopWindowTarget<UiEvent>, ui: &mut Ui_) -> Result<Entry, String> {
    let primary = win::primary_display();
    let (area_w, area_h) = (f64::from(primary.work.w) / primary.scale, f64::from(primary.work.h) / primary.scale);
    let (width, height) = (1350f64.min(area_w), 900f64.min(area_h));
    let (x, y) = (primary.work.x + (primary.work.w - (width * primary.scale) as i32) / 2, primary.work.y + (primary.work.h - (height * primary.scale) as i32) / 2);
    let window = WindowBuilder::new()
        .with_title(APP_TITLE)
        .with_decorations(false)
        .with_undecorated_shadow(true)
        .with_visible(false)
        .with_inner_size(LogicalSize::new(width, height))
        .with_min_inner_size(LogicalSize::new(640f64.min(area_w), 480f64.min(area_h)))
        .with_position(PhysicalPosition::new(x, y))
        .with_window_icon(icon(16))
        .with_taskbar_icon(icon(32))
        .build(target)
        .map_err(|e| e.to_string())?;
    place_content(&window, x, y);
    if let Some((placement, maximized)) = ui.main_placement.take() {
        // Restored hidden; the page asks to be shown once it has rendered.
        let _ = unsafe { SetWindowPlacement(HWND(window.hwnd() as _), &WINDOWPLACEMENT { showCmd: SW_HIDE.0 as u32, ..placement }) };
        ui.show_maximized = maximized;
    }
    win::MAIN_HWND.store(window.hwnd(), Ordering::SeqCst);
    crate::trace("main window created");
    let webview = ui.webview(&window, WindowKey::Main)?;
    crate::trace("WebView2 ready");
    Ok(Entry { window, webview, spec: None })
}

/// Brings the main window forward. If its web engine was released while it sat in the tray, a new one is started instead;
/// the page asks to be shown once it has rendered, as it does at start-up.
fn show_main(target: &EventLoopWindowTarget<UiEvent>, ui: &mut Ui_, entries: &mut HashMap<WindowId, Entry>, by_key: &mut HashMap<WindowKey, WindowId>) {
    let Some(id) = by_key.get(&WindowKey::Main).copied().filter(|id| entries.contains_key(id)) else {
        match create_main(target, ui) {
            Ok(entry) => {
                by_key.insert(WindowKey::Main, entry.window.id());
                entries.insert(entry.window.id(), entry);
            }
            Err(error) => eprintln!("Still could not reopen its window: {error}"),
        }
        return;
    };
    let main = &entries[&id];
    if main.window.is_minimized() {
        main.window.set_minimized(false);
    }
    if std::mem::take(&mut ui.show_maximized) {
        let _ = unsafe { ShowWindow(HWND(main.window.hwnd() as _), SW_SHOWMAXIMIZED) };
    }
    main.window.set_visible(true);
    main.window.set_focus();
}

/// Runs the event loop until `UiEvent::Exit`; returns the process exit code.
pub fn run(mut event_loop: EventLoop<UiEvent>, cfg: UiConfig, proxy: Ui) -> i32 {
    let mut ui = Ui_ { cfg: &cfg, proxy: proxy.clone(), web_context: WebContext::new(Some(cfg.web_data.clone())), main_placement: None, show_maximized: false };
    let mut entries: HashMap<WindowId, Entry> = HashMap::new();
    let mut by_key: HashMap<WindowKey, WindowId> = HashMap::new();
    let mut presentation = true;
    let mut quitting = false;

    match create_main(&event_loop, &mut ui) {
        Ok(entry) => {
            by_key.insert(WindowKey::Main, entry.window.id());
            entries.insert(entry.window.id(), entry);
        }
        Err(error) => {
            win::error_box("Still could not start", &format!("{error}\n\nStill needs the Microsoft Edge WebView2 Runtime, which is included with current versions of Windows. Install it from microsoft.com/edge/webview2, then reopen Still."));
            return 1;
        }
    }

    // The tray icon keeps Still running after its window is closed.
    let open_item = MenuItem::with_id("open", "Open Still", true, None);
    let quit_item = MenuItem::with_id("quit", &cfg.quit_label, true, None);
    let menu = Menu::with_items(&[&open_item, &PredefinedMenuItem::separator(), &quit_item]).expect("the tray menu can be created");
    let tray_size = unsafe { GetSystemMetrics(SM_CXSMICON) }.max(16) as u32;
    let mut tray: Option<TrayIcon> = TrayIconBuilder::new()
        .with_menu(Box::new(menu))
        // Like Electron's tray on Windows: the menu opens on right-click; a double-click opens the window.
        .with_menu_on_left_click(false)
        .with_tooltip("Still · Make room for focus")
        .with_icon(tray_icon::Icon::from_resource(1, Some((tray_size, tray_size))).expect("the tray icon resource exists"))
        .build()
        .ok();
    crate::trace(if tray.is_some() { "tray icon created" } else { "tray icon FAILED" });
    let (p1, p2) = (proxy.clone(), proxy.clone());
    TrayIconEvent::set_event_handler(Some(move |event| {
        let _ = p1.send_event(UiEvent::Tray(event));
    }));
    MenuEvent::set_event_handler(Some(move |event: MenuEvent| {
        let _ = p2.send_event(UiEvent::Menu(event.id.0));
    }));

    // While the main window sits in the tray a timer runs; `epoch` tells a timer which hide it belongs to.
    let (mut in_tray, mut epoch) = (false, 0u64);
    let exit_code = event_loop.run_return(|event, target, flow| {
        *flow = ControlFlow::Wait;
        match event {
            Event::UserEvent(UiEvent::ReleaseMain(token)) => {
                let main = by_key.get(&WindowKey::Main).copied();
                if token == epoch && main.and_then(|id| entries.get(&id)).is_some_and(|e| !e.window.is_visible()) {
                    // ponytail: a window hidden while in F11 full screen comes back centered instead (rare; tao keeps its pre-full-screen rect privately).
                    if let Some(entry) = main.and_then(|id| entries.get(&id)).filter(|e| e.window.fullscreen().is_none()) {
                        let mut placement = WINDOWPLACEMENT { length: std::mem::size_of::<WINDOWPLACEMENT>() as u32, ..Default::default() };
                        if unsafe { GetWindowPlacement(HWND(entry.window.hwnd() as _), &mut placement) }.is_ok() {
                            ui.main_placement = Some((placement, entry.window.is_maximized()));
                        }
                    }
                    by_key.remove(&WindowKey::Main);
                    entries.remove(&main.unwrap());
                    win::MAIN_HWND.store(0, Ordering::SeqCst);
                    crate::trace("web engine released");
                }
            }
            Event::UserEvent(event) => handle_user_event(event, target, &mut ui, &mut entries, &mut by_key, &mut quitting, &mut tray, &quit_item, flow),
            Event::WindowEvent { window_id, event: WindowEvent::CloseRequested, .. } => {
                let Some(entry) = entries.get(&window_id) else { return };
                match entry.spec {
                    // An alarm window closes through the alarm logic, which also clears its queue.
                    Some(ref spec) => {
                        let _ = cfg.core.send(CoreMsg::AlarmClosed(spec.id));
                    }
                    // Closing the main window hides it to the tray; only Quit really exits.
                    None if !quitting && tray.is_some() => entry.window.set_visible(false),
                    None => *flow = ControlFlow::Exit,
                }
            }
            _ => {}
        }
        let hidden = by_key.get(&WindowKey::Main).and_then(|id| entries.get(id)).is_some_and(|main| !main.window.is_visible());
        if hidden != in_tray {
            in_tray = hidden;
            epoch += 1;
            if let (true, Some(delay)) = (hidden, cfg.release_after) {
                let (proxy, token) = (proxy.clone(), epoch);
                std::thread::spawn(move || {
                    std::thread::sleep(delay);
                    let _ = proxy.send_event(UiEvent::ReleaseMain(token));
                });
            }
        }
        // Tell the page whether it is on screen so it can pause work while hidden or minimized.
        if let Some(main) = by_key.get(&WindowKey::Main).and_then(|id| entries.get(id)) {
            let visible = main.window.is_visible() && !main.window.is_minimized();
            if visible != presentation {
                presentation = visible;
                let _ = main.webview.evaluate_script(&emit_script("presentation-visible", &Value::Bool(visible)));
            }
        }
    });
    drop(tray);
    exit_code
}

#[allow(clippy::too_many_arguments)]
fn handle_user_event(
    event: UiEvent,
    target: &EventLoopWindowTarget<UiEvent>,
    ui: &mut Ui_,
    entries: &mut HashMap<WindowId, Entry>,
    by_key: &mut HashMap<WindowKey, WindowId>,
    quitting: &mut bool,
    tray: &mut Option<TrayIcon>,
    quit_item: &MenuItem,
    flow: &mut ControlFlow,
) {
    let cfg = ui.cfg;
    let entry_of = |entries: &HashMap<WindowId, Entry>, by_key: &HashMap<WindowKey, WindowId>, key: WindowKey| -> Option<WindowId> { by_key.get(&key).filter(|id| entries.contains_key(id)).copied() };
    match event {
        UiEvent::Eval(key, script) => {
            if let Some(entry) = entry_of(entries, by_key, key).and_then(|id| entries.get(&id)) {
                let _ = entry.webview.evaluate_script(&script);
            }
        }
        UiEvent::ShowMain | UiEvent::Tray(TrayIconEvent::DoubleClick { .. }) => show_main(target, ui, entries, by_key),
        UiEvent::Tray(_) => {}
        // Handled in the event loop, which owns the hide counter.
        UiEvent::ReleaseMain(_) => {}
        UiEvent::Menu(id) => match id.as_str() {
            "open" => show_main(target, ui, entries, by_key),
            "quit" => {
                *quitting = true;
                let _ = cfg.core.send(CoreMsg::Quit);
            }
            _ => {}
        },
        UiEvent::QuitLabel(label) => quit_item.set_text(label),
        UiEvent::OpenAlarm(spec) => {
            let (w, h) = (spec.area.w.max(1) as u32, spec.area.h.max(1) as u32);
            let key = WindowKey::Alarm(spec.id);
            let built = WindowBuilder::new()
                .with_title("Still · A moment for your attention")
                .with_decorations(false)
                .with_resizable(false)
                .with_minimizable(false)
                .with_maximizable(false)
                .with_skip_taskbar(true)
                .with_visible(false)
                .with_position(PhysicalPosition::new(spec.area.x, spec.area.y))
                .with_inner_size(PhysicalSize::new(w, h))
                .with_window_icon(icon(16))
                .build(target);
            if let Ok(window) = built {
                place_content(&window, spec.area.x, spec.area.y);
                if let Ok(webview) = ui.webview(&window, key) {
                    by_key.insert(key, window.id());
                    entries.insert(window.id(), Entry { window, webview, spec: Some(spec) });
                }
            }
        }
        UiEvent::ShowAlarm(id) => {
            if let Some(entry) = entry_of(entries, by_key, WindowKey::Alarm(id)).and_then(|w| entries.get(&w)) {
                let spec = entry.spec.as_ref();
                if spec.is_some_and(|s| s.full) {
                    entry.window.set_fullscreen(Some(Fullscreen::Borderless(entry.window.current_monitor())));
                }
                if spec.is_some_and(|s| !s.on_top) {
                    unsafe {
                        let _ = ShowWindow(HWND(entry.window.hwnd() as _), SW_SHOWNOACTIVATE);
                    }
                } else {
                    entry.window.set_always_on_top(true);
                    entry.window.set_visible(true);
                    entry.window.set_focus();
                }
            }
        }
        UiEvent::CloseAlarm(id) => {
            if let Some(window_id) = by_key.remove(&WindowKey::Alarm(id)) {
                entries.remove(&window_id);
            }
        }
        UiEvent::Call { from, uri, call } => handle_call(from, &uri, call, ui, entries, by_key, quitting),
        UiEvent::Exit => {
            tray.take();
            entries.clear();
            *flow = ControlFlow::Exit;
        }
    }
}

/// Calls that the window layer answers itself; everything else goes to the app logic.
fn handle_call(from: WindowKey, uri: &str, call: Call, ui: &Ui_, entries: &HashMap<WindowId, Entry>, by_key: &HashMap<WindowKey, WindowId>, quitting: &bool) {
    let Some(entry) = by_key.get(&from).and_then(|id| entries.get(id)) else { return };
    let page = if from == WindowKey::Main { APP_URL } else { ALARM_URL };
    let answer = |result: Result<Value, String>| {
        if let Some(id) = call.id {
            let _ = entry.webview.evaluate_script(&reply_script(id, &result));
        }
    };
    // Only the app's own page may talk to the app (the equivalent of Electron's sender-frame check).
    if !same_page_url(uri, page) {
        return answer(Err("Untrusted request.".into()));
    }
    let window = &entry.window;
    match call.name.as_str() {
        "setZoom" => {
            if let Some(factor) = call.args.first().and_then(Value::as_f64).filter(|f| f.is_finite()) {
                let _ = entry.webview.zoom(factor.clamp(1.0, 1.75));
            }
        }
        "window" if from == WindowKey::Main => {
            match call.args.first().and_then(Value::as_str) {
                Some("minimize") => window.set_minimized(true),
                Some("maximize") => window.set_maximized(!window.is_maximized()),
                // Closing hides to the tray while the tray icon exists.
                Some("close") if !*quitting => window.set_visible(false),
                _ => {}
            }
            answer(Ok(Value::Null));
        }
        // The roles of Electron's default menu, acting on the window the shortcut was pressed in.
        "accelerator" => match call.args.first().and_then(Value::as_str) {
            Some("close") => match &entry.spec {
                Some(spec) => {
                    let _ = ui.cfg.core.send(CoreMsg::AlarmClosed(spec.id));
                }
                None if !*quitting => window.set_visible(false),
                None => {}
            },
            Some("minimize") => window.set_minimized(true),
            Some("togglefullscreen") => window.set_fullscreen(if window.fullscreen().is_some() { None } else { Some(Fullscreen::Borderless(window.current_monitor())) }),
            Some("reload" | "forceReload") => {
                let _ = entry.webview.reload();
            }
            // WebView2 can open DevTools but not close it; its own window does that.
            Some("toggleDevTools") => entry.webview.open_devtools(),
            // Zoom levels step by half a level; a level is a factor of 1.2.
            Some(zoom @ ("resetZoom" | "zoomIn" | "zoomOut")) => {
                use wry::WebViewExtWindows;
                let mut factor = 1.0;
                let _ = unsafe { entry.webview.controller().ZoomFactor(&mut factor) };
                let level = factor.ln() / 1.2f64.ln();
                let next = match zoom {
                    "zoomIn" => 1.2f64.powf(level + 0.5),
                    "zoomOut" => 1.2f64.powf(level - 0.5),
                    _ => 1.0,
                };
                let _ = entry.webview.zoom(next);
            }
            _ => {}
        },
        "showWindow" if from == WindowKey::Main => {
            crate::trace("page asked to show the window");
            // The page asks once it has rendered; a quiet alarm-wake start ignores that first request.
            if ui.cfg.start_hidden.swap(false, Ordering::SeqCst) {
                return answer(Ok(Value::Null));
            }
            let _ = ui.proxy.send_event(UiEvent::ShowMain);
            answer(Ok(Value::Null));
        }
        "__test:windows" if ui.cfg.testing => {
            let mut list: Vec<(bool, Value)> = entries
                .values()
                .map(|e| (e.spec.is_some(), json!({ "url": if e.spec.is_some() { ALARM_URL } else { APP_URL }, "alwaysOnTop": e.window.is_always_on_top(), "fullscreen": e.window.fullscreen().is_some(), "visible": e.window.is_visible(), "maximized": e.window.is_maximized(), "bounds": e.window.inner_position().map(|p| { let size = e.window.inner_size(); [p.x, p.y, size.width as i32, size.height as i32] }).ok() })))
                .collect();
            list.sort_by_key(|(alarm, _)| *alarm);
            let report = Value::Array(list.into_iter().map(|(_, v)| v).collect());
            let _ = entry.webview.evaluate_script(&format!("window.__testResult = {report}"));
        }
        "__test:hide" if ui.cfg.testing && from == WindowKey::Main => window.set_visible(false),
        // The tray menu's Quit (Electron's tests called app.quit()).
        "__test:quit" if ui.cfg.testing => {
            let _ = ui.proxy.send_event(UiEvent::Menu("quit".into()));
        }
        // Electron's setContentSize: the window's client area in logical pixels.
        "__test:resize" if ui.cfg.testing && from == WindowKey::Main => {
            if let [Some(w), Some(h)] = [call.args.first(), call.args.get(1)].map(|v| v.and_then(Value::as_f64)) {
                window.set_inner_size(LogicalSize::new(w, h));
            }
        }
        "alarm-ready" => {
            if let WindowKey::Alarm(id) = from {
                let _ = ui.cfg.core.send(CoreMsg::AlarmReady(id));
            }
        }
        name => {
            let id = call.id.unwrap_or(0);
            let _ = ui.cfg.core.send(CoreMsg::Invoke { from, id, name: name.to_string(), args: call.args });
        }
    }
}
