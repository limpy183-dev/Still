// Still: a quieter space for your attention. The Windows app, in Rust.
#![windows_subsystem = "windows"]

mod alerts;
mod app;
mod apps;
mod discover;
mod guard;
mod ui;
mod websites;
mod win;

use std::{
    path::PathBuf,
    sync::{Arc, atomic::{AtomicBool, Ordering}},
};
use tao::event_loop::EventLoopBuilder;

/// Start-up timeline for diagnosing slowness: with `STILL_TRACE=<file>` set, each stage is logged with its time since launch.
pub fn trace(stage: &str) {
    static START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
    static FILE: std::sync::OnceLock<Option<std::ffi::OsString>> = std::sync::OnceLock::new();
    let start = START.get_or_init(std::time::Instant::now);
    if let Some(file) = FILE.get_or_init(|| std::env::var_os("STILL_TRACE")) {
        use std::io::Write;
        if let Ok(mut out) = std::fs::OpenOptions::new().create(true).append(true).open(file) {
            let _ = writeln!(out, "{:>6} ms  {stage}", start.elapsed().as_millis());
        }
    }
}

/// Set by the quit path when an alert is about to ring: the next instance is started once this one is gone.
pub static RELAUNCH: AtomicBool = AtomicBool::new(false);

/// How this run was started (`--demo`, `--test`, `--alarm-wake`), mirroring the Electron flags.
pub struct Mode {
    pub demo: bool,
    pub testing: bool,
    pub alarm_wake: bool,
    pub user_data: PathBuf,
    pub packaged: bool,
}

impl Mode {
    fn detect() -> Mode {
        let args: Vec<String> = std::env::args().skip(1).collect();
        let (demo, testing) = (args.iter().any(|a| a == "--demo"), args.iter().any(|a| a == "--test"));
        let test_data = args.iter().find_map(|a| a.strip_prefix("--test-data=")).filter(|_| testing).map(PathBuf::from);
        // The preview and test profiles are temporary, so they never touch real preferences or protection.
        let user_data = match (demo || testing, test_data) {
            (true, Some(dir)) => dir,
            (true, None) if testing => std::env::temp_dir().join(format!("Still-test-{}-{}", std::process::id(), still_core::session::now_ms())),
            (true, None) => std::env::temp_dir().join("Still-preview"),
            (false, _) => PathBuf::from(std::env::var_os("APPDATA").unwrap_or_default()).join("still-focus"),
        };
        let exe = std::env::current_exe().unwrap_or_default();
        let packaged = !exe.ancestors().any(|dir| dir.file_name().is_some_and(|n| n == "target"));
        Mode { demo, testing, alarm_wake: args.iter().any(|a| a == "--alarm-wake"), user_data, packaged }
    }
}

fn main() {
    trace("main");
    let mode = Mode::detect();
    let profile = mode.user_data.to_string_lossy().into_owned();
    let Some(_lock) = win::single_instance(&profile) else {
        // A second launch just brings the first window forward (alarm-wake launches stay quiet).
        if !mode.alarm_wake {
            win::signal_first_instance(&profile);
        }
        return;
    };
    let event_loop = EventLoopBuilder::<ui::UiEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();
    let (core_tx, core_rx) = tokio::sync::mpsc::unbounded_channel();
    let start_hidden = Arc::new(AtomicBool::new(mode.alarm_wake));
    let prefs = app::Preferences::load(&mode.user_data);
    let cfg = ui::UiConfig {
        web_data: if mode.demo || mode.testing { mode.user_data.join("WebView2") } else { PathBuf::from(std::env::var_os("LOCALAPPDATA").unwrap_or_default()).join("Still").join("WebView2") },
        media_dir: mode.user_data.join("alert-media"),
        start_hidden: start_hidden.clone(),
        core: core_tx,
        quit_label: app::quit_label(prefs.alerts_after_quit()),
        testing: mode.testing,
        // STILL_ENGINE_RELEASE_SECS: seconds in the tray before the web engine is released (0 = never). 90 by default; the test runs keep it unless asked.
        release_after: match std::env::var("STILL_ENGINE_RELEASE_SECS").ok().and_then(|v| v.parse::<u64>().ok()) {
            Some(0) => None,
            Some(seconds) => Some(std::time::Duration::from_secs(seconds)),
            None => (!mode.testing).then_some(std::time::Duration::from_secs(90)),
        },
    };
    let ping = proxy.clone();
    win::listen_for_second_instance(&profile, move || {
        let _ = ping.send_event(ui::UiEvent::ShowMain);
    });
    let wake_profile = mode.testing.then(|| mode.user_data.clone());
    let logic = std::thread::Builder::new()
        .name("still-logic".into())
        .spawn({
            let (proxy, core_tx) = (proxy.clone(), cfg.core.clone());
            move || app::run(mode, prefs, proxy, core_rx, core_tx)
        })
        .expect("the logic thread starts");
    trace("starting window layer");
    let code = ui::run(event_loop, cfg, proxy);
    let _ = logic.join();
    drop(_lock);
    if RELAUNCH.load(Ordering::SeqCst) {
        app::relaunch(wake_profile.as_deref());
    }
    std::process::exit(code);
}
