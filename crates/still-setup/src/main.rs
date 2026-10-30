// Still Setup: installs or updates Still for the current Windows user (no administrator approval).
// With the app payload appended to it this program is the installer; the copy it writes beside the app,
// without the payload, is the uninstaller. The Rust port of installer/Setup.cs and Setup.xaml.
#![windows_subsystem = "windows"]

mod install;

use install::{Ctx, Payload};
use serde_json::{Value, json};
use std::{
    borrow::Cow,
    sync::{Arc, atomic::{AtomicBool, Ordering}},
};
use tao::{
    dpi::{LogicalSize, PhysicalPosition},
    event::{Event, WindowEvent},
    event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy},
    platform::{run_return::EventLoopExtRunReturn, windows::IconExtWindows},
    window::{Icon, WindowBuilder},
};
use windows::{
    Win32::{
        Foundation::{CloseHandle, ERROR_ALREADY_EXISTS, GetLastError, RECT},
        System::{LibraryLoader::{LOAD_LIBRARY_SEARCH_SYSTEM32, SetDefaultDllDirectories}, Threading::CreateMutexW},
        UI::WindowsAndMessaging::{MB_ICONINFORMATION, MB_OK, MessageBoxW, SPI_GETWORKAREA, SystemParametersInfoW, SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS},
    },
    core::HSTRING,
};
use wry::{WebViewBuilder, WebViewBuilderExtWindows, http::{Response, header}};

const PAGE: &str = include_str!("../ui/index.html");
const FONTS: [(&str, &[u8]); 3] = [
    ("/Manrope-Medium.ttf", include_bytes!("../../../installer/Manrope-Medium.ttf")),
    ("/Manrope-SemiBold.ttf", include_bytes!("../../../installer/Manrope-SemiBold.ttf")),
    ("/Manrope-ExtraBold.ttf", include_bytes!("../../../installer/Manrope-ExtraBold.ttf")),
];
const URL: &str = "https://setup.localhost/index.html";
const VERSION: &str = env!("CARGO_PKG_VERSION");

enum Ui {
    Eval(String),
    Close,
    Minimize,
    Exit,
}

fn eval(call: &str, argument: &Value) -> Ui {
    Ui::Eval(format!("window.setup.{call}({argument})"))
}

fn serve(path: &str) -> Response<Cow<'static, [u8]>> {
    let (kind, body): (&str, Cow<'static, [u8]>) = match path {
        "/" | "/index.html" => ("text/html; charset=utf-8", Cow::Borrowed(PAGE.as_bytes())),
        font => match FONTS.iter().find(|(name, _)| *name == font) {
            Some((_, bytes)) => ("font/ttf", Cow::Borrowed(*bytes)),
            None => return Response::builder().status(404).body(Cow::Borrowed(&b""[..])).unwrap(),
        },
    };
    Response::builder().status(200).header(header::CONTENT_TYPE, kind).header(header::CACHE_CONTROL, "no-cache").body(body).unwrap()
}

fn main() {
    unsafe {
        // Load native DLLs only from System32, never from the folder Setup was downloaded to.
        let _ = SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32);
    }
    let mutex = unsafe { CreateMutexW(None, true, &HSTRING::from(r"Local\Still.Setup")) };
    let Ok(mutex) = mutex else { return };
    if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
        return;
    }
    let payload = Payload::from_self();
    if payload.is_some() {
        if let Err(message) = still_core::compat::ensure() {
            unsafe { MessageBoxW(None, &HSTRING::from(message), &HSTRING::from("Still Setup"), MB_OK | MB_ICONINFORMATION) };
            std::process::exit(1);
        }
    }
    let ctx = Arc::new(Ctx::new(payload));
    let busy = Arc::new(AtomicBool::new(false));
    let mut event_loop = EventLoopBuilder::<Ui>::with_user_event().build();
    let proxy: EventLoopProxy<Ui> = event_loop.create_proxy();

    // The window fits small desktops by scaling down, as the WPF original did.
    let mut work = RECT::default();
    unsafe {
        let _ = SystemParametersInfoW(SPI_GETWORKAREA, 0, Some(&mut work as *mut _ as *mut _), SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0));
    }
    let dpi_scale = event_loop.primary_monitor().map_or(1.0, |m| m.scale_factor());
    let (work_w, work_h) = (f64::from(work.right - work.left) / dpi_scale, f64::from(work.bottom - work.top) / dpi_scale);
    let scale = 1f64.min(work_w / 640.0).min(work_h / 500.0);
    let (width, height) = (640.0 * scale, 500.0 * scale);
    let position = PhysicalPosition::new(f64::from(work.left) + (f64::from(work.right - work.left) - width * dpi_scale) / 2.0, f64::from(work.top) + (f64::from(work.bottom - work.top) - height * dpi_scale) / 2.0);
    let window = WindowBuilder::new()
        .with_title("Still Setup")
        .with_decorations(false)
        .with_transparent(true)
        // Fixed size by constraint, not by style: a non-resizable window keeps a visible system frame.
        .with_maximizable(false)
        .with_inner_size(LogicalSize::new(width, height))
        .with_min_inner_size(LogicalSize::new(width, height))
        .with_max_inner_size(LogicalSize::new(width, height))
        .with_position(position)
        .with_window_icon(Icon::from_resource(1, None).ok())
        .build(&event_loop)
        .expect("the setup window can be created");

    let web_data = std::env::temp_dir().join(format!("Still-Setup-{VERSION}")).join("WebView2");
    let mut web_context = wry::WebContext::new(Some(web_data));
    let (ipc_proxy, ipc_ctx, ipc_busy) = (proxy.clone(), ctx.clone(), busy.clone());
    let webview = WebViewBuilder::new_with_web_context(&mut web_context)
        .with_transparent(true)
        .with_background_color((0, 0, 0, 0))
        .with_url(URL)
        .with_custom_protocol("setup".into(), |_, request| serve(request.uri().path()))
        .with_https_scheme(true)
        .with_devtools(false)
        .with_hotkeys_zoom(false)
        .with_browser_accelerator_keys(false)
        .with_default_context_menus(false)
        .with_navigation_handler(|url| url == URL)
        .with_new_window_req_handler(|_, _| wry::NewWindowResponse::Deny)
        .with_ipc_handler(move |request| {
            if request.uri() != URL {
                return;
            }
            let Ok(message) = serde_json::from_str::<Value>(request.body()) else { return };
            match message["op"].as_str().unwrap_or_default() {
                "init" => {
                    let _ = ipc_proxy.send_event(eval("init", &ipc_ctx.state()));
                }
                "minimize" => {
                    let _ = ipc_proxy.send_event(Ui::Minimize);
                }
                "close" => {
                    if !ipc_busy.load(Ordering::SeqCst) {
                        let _ = ipc_proxy.send_event(Ui::Close);
                    }
                }
                "finish" => {
                    ipc_ctx.finish(message["launch"].as_bool() == Some(true));
                    let _ = ipc_proxy.send_event(Ui::Exit);
                }
                op @ ("install" | "uninstall") => {
                    if ipc_busy.swap(true, Ordering::SeqCst) {
                        return;
                    }
                    let (ctx, proxy, busy) = (ipc_ctx.clone(), ipc_proxy.clone(), ipc_busy.clone());
                    let message = message.clone();
                    let install = op == "install";
                    std::thread::spawn(move || {
                        let report = |status: &str, percent: f64| {
                            let _ = proxy.send_event(Ui::Eval(format!("window.setup.report({}, {percent})", json!(status))));
                        };
                        let outcome = if install { ctx.install(message["desktop"].as_bool() == Some(true), &report) } else { ctx.uninstall(message["guard"].as_bool() == Some(true), message["data"].as_bool() == Some(true), &report) };
                        busy.store(false, Ordering::SeqCst);
                        let _ = proxy.send_event(match outcome {
                            Ok(()) => Ui::Eval(format!("window.setup.{}()", if install { "installed" } else { "uninstalled" })),
                            Err(message) => eval("failed", &json!(message)),
                        });
                    });
                }
                _ => {}
            }
        })
        .build(&window);
    let Ok(webview) = webview else {
        let message = "Still needs the Microsoft Edge WebView2 Runtime, which is included with current versions of Windows. Install it from microsoft.com/edge/webview2, then run Setup again.";
        unsafe { MessageBoxW(None, &HSTRING::from(message), &HSTRING::from("Still Setup"), MB_OK | MB_ICONINFORMATION) };
        std::process::exit(1);
    };
    let _ = webview.zoom(scale);

    let code = event_loop.run_return(|event, _, flow| {
        *flow = ControlFlow::Wait;
        match event {
            Event::UserEvent(Ui::Eval(script)) => {
                let _ = webview.evaluate_script(&script);
            }
            Event::UserEvent(Ui::Minimize) => window.set_minimized(true),
            Event::UserEvent(Ui::Close | Ui::Exit) => *flow = ControlFlow::Exit,
            Event::WindowEvent { event: WindowEvent::CloseRequested, .. } if !busy.load(Ordering::SeqCst) => *flow = ControlFlow::Exit,
            _ => {}
        }
    });
    drop(webview);
    unsafe {
        let _ = CloseHandle(mutex);
    }
    ctx.after_exit();
    std::process::exit(code);
}
