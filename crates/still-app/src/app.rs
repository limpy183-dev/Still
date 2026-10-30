//! The app logic, ported from Electron's main process (`main.cjs`): preferences, protection status, sessions,
//! updates, the wake task and every request the page can make. It runs on one thread, like the original Node process.
use crate::{
    Mode, RELAUNCH, apps,
    alerts::Alerts,
    guard::GuardClient,
    ui::{CoreMsg, Ui, UiEvent, WindowKey, emit_script, reply_script},
    websites, win,
};
use serde_json::{Map, Value, json};
use std::{
    cell::{Cell, RefCell},
    path::{Path, PathBuf},
    rc::Rc,
    sync::atomic::Ordering,
    time::Duration,
};
use still_core::{alerts::wake_task_xml, domain, js::str_of, session::now_ms};
use tokio::{sync::mpsc::{UnboundedReceiver, UnboundedSender}, task::spawn_local, time::sleep};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
pub const APP_ID: &str = "app.still.focus";

/// The validated preferences file.
pub struct Preferences {
    pub value: Value,
}

/// Still 1.1.6 and older rewrite preferences.json with only the fields they know, which drops `newThings`.
/// A copy kept beside it puts the list back when the field comes back missing (an empty list is kept as empty).
const NEW_THINGS: &str = "new-things.json";

fn save_new_things(user_data: &Path, preferences: &Value) {
    let _ = write_atomic(&user_data.join(NEW_THINGS), &preferences["newThings"].to_string());
}

impl Preferences {
    pub fn load(user_data: &Path) -> Preferences {
        let mut raw = std::fs::read_to_string(user_data.join("preferences.json"))
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .filter(Value::is_object);
        if let Some(raw) = raw.as_mut().filter(|raw| raw.get("newThings").is_none()) {
            if let Some(saved) = std::fs::read_to_string(user_data.join(NEW_THINGS)).ok().and_then(|text| serde_json::from_str::<Value>(&text).ok()) {
                raw["newThings"] = saved;
            }
        }
        let loaded = raw.and_then(|v| domain::validate_preferences(&v).ok());
        if let Some(value) = &loaded {
            save_new_things(user_data, value); // so a file Electron 1.2.0 wrote survives a later 1.1.6
        }
        let value = loaded.or_else(|| domain::validate_preferences(&json!({})).ok()).unwrap_or_default();
        Preferences { value }
    }
    pub fn alerts_after_quit(&self) -> bool {
        self.value["alertsAfterQuit"] == true
    }
}

pub fn quit_label(alerts_after_quit: bool) -> String {
    if alerts_after_quit { "Quit Still (alerts still ring; active protection continues)" } else { "Quit Still (alerts stop; active protection continues)" }.into()
}

pub fn write_atomic(file: &Path, text: &str) -> std::io::Result<()> {
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = file.with_file_name(format!("{}.tmp", file.file_name().unwrap_or_default().to_string_lossy()));
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, file)
}

#[derive(Default)]
struct DemoState {
    installed: bool,
    session: Option<Map<String, Value>>,
    history: Vec<Value>,
    revision: String,
}

#[derive(Clone, Copy, PartialEq)]
enum WakeAt {
    Unset,
    Off,
    At(i64),
}

pub struct App {
    pub mode: Mode,
    pub ui: Ui,
    pub tx: UnboundedSender<CoreMsg>,
    pub prefs: RefCell<Rc<Value>>,
    pub guard: Rc<GuardClient>,
    pub alerts: RefCell<Option<Rc<Alerts>>>,
    demo: RefCell<DemoState>,
    last_session: RefCell<Value>,
    next_alert_at: Cell<Option<i64>>,
    wake_at: Cell<WakeAt>,
    wake_queue: tokio::sync::Mutex<()>,
    login: RefCell<Option<(bool, PathBuf)>>,
    download_url: RefCell<Option<String>>,
    polling: Cell<bool>,
    sent_revision: RefCell<Option<Value>>,
}

pub fn exe_dir() -> PathBuf {
    std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf)).unwrap_or_default()
}

/// Starts the app again with the wake arguments (used when quitting a few seconds before an alert);
/// a `--test` run passes its profile so it reopens that, never the real one.
pub fn relaunch(test_data: Option<&Path>) {
    use std::os::windows::process::CommandExt;
    let _ = std::process::Command::new(std::env::current_exe().unwrap_or_default()).args(wake_args(test_data)).creation_flags(CREATE_NO_WINDOW).spawn();
}

fn wake_args(test_data: Option<&Path>) -> Vec<String> {
    let mut args = vec!["--alarm-wake".to_string()];
    if let Some(dir) = test_data {
        args.extend(["--test".into(), format!("--test-data={}", dir.display())]);
    }
    args
}

/// The logic thread: sets everything up, then answers the page until the app quits.
pub fn run(mode: Mode, prefs: Preferences, ui: Ui, rx: UnboundedReceiver<CoreMsg>, tx: UnboundedSender<CoreMsg>) {
    use windows::Win32::System::Com::{COINIT_MULTITHREADED, CoInitializeEx};
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("the async runtime starts");
    tokio::task::LocalSet::new().block_on(&runtime, async move {
        let app = Rc::new(App {
            mode,
            ui,
            tx,
            prefs: RefCell::new(Rc::new(prefs.value)),
            guard: Rc::new(GuardClient::default()),
            alerts: RefCell::new(None),
            demo: RefCell::new(DemoState { revision: uuid::Uuid::new_v4().to_string(), ..Default::default() }),
            last_session: RefCell::new(Value::Null),
            next_alert_at: Cell::new(None),
            wake_at: Cell::new(WakeAt::Unset),
            wake_queue: tokio::sync::Mutex::new(()),
            login: RefCell::new(None),
            download_url: RefCell::new(None),
            polling: Cell::new(false),
            sent_revision: RefCell::new(None),
        });
        crate::trace("logic thread starts");
        app.startup().await;
        crate::trace("logic ready");
        app.serve(rx).await;
    });
}

impl App {
    pub fn prefs(&self) -> Rc<Value> {
        self.prefs.borrow().clone()
    }

    pub fn version(&self) -> &'static str {
        env!("CARGO_PKG_VERSION")
    }

    /// In a `--test` run, file dialogs answer from `test-pick.txt` (one path per line) instead of opening,
    /// the way the original tests replaced Electron's dialogs. Never used outside `--test`.
    pub fn test_pick(&self) -> Option<Vec<PathBuf>> {
        if !self.mode.testing {
            return None;
        }
        let text = std::fs::read_to_string(self.mode.user_data.join("test-pick.txt")).ok()?;
        Some(text.lines().filter(|l| !l.trim().is_empty()).map(PathBuf::from).collect())
    }

    /// Where the Windows protection files (service, policy script) ship: next to the app, in `guard/`.
    pub fn guard_dir(&self) -> PathBuf {
        let dir = exe_dir();
        if dir.join("guard").join("Still.Guard.exe").exists() { dir.join("guard") } else { dir }
    }

    fn program_files(&self) -> PathBuf {
        PathBuf::from(std::env::var("ProgramFiles").unwrap_or_else(|_| "C:\\Program Files".into()))
    }

    pub fn emit(&self, channel: &str, value: &Value) {
        let _ = self.ui.send_event(UiEvent::Eval(WindowKey::Main, emit_script(channel, value)));
    }

    pub fn alert_error(&self, message: impl Into<String>) {
        self.emit("alert-error", &json!(message.into()));
    }

    async fn startup(self: &Rc<Self>) {
        let _ = std::fs::create_dir_all(&self.mode.user_data);
        if let Err(error) = self.reconcile_login() {
            eprintln!("Sign-in settings: {error}");
        }
        win::set_app_id(APP_ID);
        if self.mode.packaged && !self.mode.demo && !self.mode.testing {
            // Portable builds have no installer to register their Windows notification identity.
            if let Some(programs) = win::programs_folder() {
                let _ = std::fs::create_dir_all(&programs);
                let target = std::env::current_exe().unwrap_or_default();
                let activator = windows::core::GUID::from_u128(0x2BB3B6B9_632E_4618_9488_990BD152DD54);
                if let Err(error) = win::write_shortcut(&programs.join("Still Focus.lnk"), &target, "Still — a space for focus", APP_ID, activator) {
                    eprintln!("Notification registration: {error}");
                }
            }
        }
        let alerts = Alerts::setup(self).await;
        *self.alerts.borrow_mut() = Some(alerts);
        websites::refresh_companion(self).await;
        let this = self.clone();
        spawn_local(async move {
            loop {
                sleep(Duration::from_secs(2)).await;
                this.poll().await;
            }
        });
        let this = self.clone();
        spawn_local(async move { this.tray_label() });
    }

    fn tray_label(&self) {
        let after_quit = self.prefs()["alertsAfterQuit"] == true;
        let _ = self.ui.send_event(UiEvent::QuitLabel(quit_label(after_quit)));
    }

    async fn serve(self: &Rc<Self>, mut rx: UnboundedReceiver<CoreMsg>) {
        while let Some(message) = rx.recv().await {
            match message {
                CoreMsg::Invoke { from, id, name, args } => {
                    let this = self.clone();
                    spawn_local(async move {
                        let result = this.dispatch(from, &name, args).await;
                        let _ = this.ui.send_event(UiEvent::Eval(from, reply_script(id, &result)));
                    });
                }
                CoreMsg::AlarmReady(id) => {
                    if let Some(alerts) = self.alerts.borrow().clone() {
                        alerts.window_ready(id);
                    }
                }
                CoreMsg::AlarmClosed(id) => {
                    if let Some(alerts) = self.alerts.borrow().clone() {
                        alerts.window_closed(id);
                    }
                }
                CoreMsg::Toast(presentation, event) => {
                    if let Some(alerts) = self.alerts.borrow().clone() {
                        alerts.toast_event(presentation, event);
                    }
                }
                CoreMsg::Quit => {
                    self.quit().await;
                    return;
                }
            }
        }
    }

    /// Finishes registering the wake task first. If its time has already passed (quitting in the last
    /// 30 s before an alert), Task Scheduler won't reopen Still, so Still reopens itself in the tray right away.
    async fn quit(self: &Rc<Self>) {
        if let Some(alerts) = self.alerts.borrow().clone() {
            alerts.close_all();
        }
        if !self.mode.demo {
            let _queued = self.wake_queue.lock().await;
            if let WakeAt::At(at) = self.wake_at.get() {
                if at <= now_ms() + 5000 {
                    RELAUNCH.store(true, Ordering::SeqCst);
                }
            }
        }
        let _ = self.ui.send_event(UiEvent::Exit);
    }

    // ---- requests from the page ----

    async fn dispatch(self: &Rc<Self>, from: WindowKey, name: &str, args: Vec<Value>) -> Result<Value, String> {
        let arg = |i: usize| args.get(i).cloned().unwrap_or(Value::Null);
        if let WindowKey::Alarm(window) = from {
            return match (name, self.alerts.borrow().clone()) {
                ("alarm-action", Some(alerts)) => alerts.alarm_action(window, &arg(0)).await,
                _ => Err("Untrusted alarm request.".into()),
            };
        }
        if let Some(alerts) = self.alerts.borrow().clone() {
            if name.starts_with("alerts:") {
                return alerts.handle(name, arg(0)).await;
            }
        }
        match name {
            "bootstrap" => {
                crate::trace("bootstrap");
                let current = self.status(true).await;
                let mut out = current.as_object().cloned().unwrap_or_default();
                let prefs = self.prefs();
                out.insert("preferences".into(), (*prefs).clone());
                out.insert("apps".into(), prefs.get("apps").filter(|a| a.is_array()).cloned().unwrap_or(json!([])));
                out.insert("version".into(), json!(self.version()));
                Ok(Value::Object(out))
            }
            "appIcons" => {
                let prefs = self.prefs();
                let list = prefs["apps"].as_array().cloned().unwrap_or_default();
                Ok(Value::Array(apps::enrich(&list).await))
            }
            "status" => Ok(self.status(false).await),
            "updateHistory" => self.update_history(&arg(0), &arg(1)).await,
            "savePreferences" => {
                let saved = self.save_preferences(&arg(0)).await?;
                self.schedule_wake(None);
                self.tray_label();
                Ok(saved)
            }
            "install" => self.elevate("install").await,
            "uninstall" => {
                if !self.status(false).await["session"].is_null() {
                    return Err("Finish your session before removing protection.".into());
                }
                self.elevate("uninstall").await
            }
            "discover" => {
                let found = apps::discover_apps(false, &[]).await?;
                Ok(Value::Array(apps::enrich(&found).await))
            }
            "browse" => self.browse().await,
            "start" => self.start_session(arg(0), false).await,
            "requestUnlock" | "cancelUnlock" | "end" => self.session_command(name).await,
            "checkForUpdates" => self.check_for_updates().await,
            "downloadUpdate" => {
                win::open_url(&domain::update_url(self.download_url.borrow().as_deref()));
                Ok(Value::Null)
            }
            "exportHistory" => self.export_history().await,
            _ => match websites::handle(self, name, arg(0)).await {
                Some(result) => result,
                None => Err(format!("Unknown request: {name}")),
            },
        }
    }

    // ---- status ----

    fn finish_demo(&self, outcome: &str) {
        let mut demo = self.demo.borrow_mut();
        if let Some(mut session) = demo.session.take() {
            session.insert("finishedAt".into(), json!(now_ms()));
            session.insert("outcome".into(), json!(outcome));
            demo.history.insert(0, Value::Object(session));
        }
        demo.revision = uuid::Uuid::new_v4().to_string();
    }

    /// Adds alarm focus windows ("Let's focus" on reminder-only alarms) to the saved session history.
    fn with_alarm_focus(&self, mut value: Value) -> Value {
        let Some(alerts) = self.alerts.borrow().clone() else { return value };
        if value.get("unavailable") == Some(&Value::Bool(true)) || !value["history"].is_array() {
            return value;
        }
        let (records, revision) = alerts.focus_history(now_ms());
        if records.is_empty() {
            return value;
        }
        let mut history: Vec<Value> = value["history"].as_array().cloned().unwrap_or_default();
        history.extend(records);
        history.sort_by_key(|record| std::cmp::Reverse(record["startedAt"].as_i64().unwrap_or(0)));
        if let Some(existing) = value["historyRevision"].as_str().filter(|s| !s.is_empty()) {
            value["historyRevision"] = json!(format!("{existing}|{revision}"));
        }
        value["history"] = Value::Array(history);
        value
    }

    pub async fn status(self: &Rc<Self>, full: bool) -> Value {
        if self.mode.demo {
            let expired = self.demo.borrow().session.as_ref().and_then(|s| s.get("endsAt")).and_then(Value::as_i64).is_some_and(|end| now_ms() >= end);
            if expired {
                self.finish_demo("completed");
            }
            let demo = self.demo.borrow();
            let value = json!({ "installed": demo.installed, "session": demo.session, "history": demo.history, "historyRevision": demo.revision, "error": null, "demo": true, "now": now_ms() });
            drop(demo);
            return self.with_alarm_focus(value);
        }
        match self.guard.status(full).await {
            Ok(value) => self.with_alarm_focus(value),
            Err(error) => json!({ "installed": false, "session": null, "history": [], "unavailable": true, "error": if error.offline { Value::Null } else { json!(error.message) }, "now": now_ms() }),
        }
    }

    async fn poll(self: &Rc<Self>) {
        if self.polling.replace(true) {
            return;
        }
        let current = self.status(false).await;
        if current.get("unavailable") != Some(&Value::Bool(true)) {
            let ended = !self.last_session.borrow().is_null() && current["session"].is_null();
            if ended && self.prefs()["notifications"] != false {
                let _ = win::show_toast(APP_ID, "A little more space. Well done.", "Your focus session has ended. Your apps and websites are available again.", None, false, |_| {});
            }
            *self.last_session.borrow_mut() = current["session"].clone();
        }
        let revision = current.get("historyRevision").cloned().filter(|r| !r.is_null());
        let unchanged = revision.is_some() && revision == *self.sent_revision.borrow();
        let payload = if unchanged {
            let mut live = current.as_object().cloned().unwrap_or_default();
            live.remove("history");
            Value::Object(live)
        } else {
            current.clone()
        };
        self.emit("guard-status", &payload);
        *self.sent_revision.borrow_mut() = if current.get("unavailable") == Some(&Value::Bool(true)) { None } else { revision };
        self.polling.set(false);
    }

    // ---- preferences, sign-in item, wake task ----

    async fn save_preferences(self: &Rc<Self>, value: &Value) -> Result<Value, String> {
        let validated = domain::validate_preferences(value)?;
        *self.prefs.borrow_mut() = Rc::new(validated.clone());
        let (dir, copy) = (self.mode.user_data.clone(), validated.clone());
        let text = serde_json::to_string_pretty(&validated).map_err(|e| e.to_string())?;
        tokio::task::spawn_blocking(move || write_atomic(&dir.join("preferences.json"), &text).map(|()| save_new_things(&dir, &copy))).await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())?;
        if let Err(error) = self.reconcile_login() {
            eprintln!("Sign-in settings: {error}");
        }
        Ok(validated)
    }

    /// "Open Still when I sign in": the per-user Run entry, changed only when its value or the executable path changes.
    fn reconcile_login(&self) -> Result<(), String> {
        use winreg::{RegKey, RegValue, enums::*};
        if !self.mode.packaged || self.mode.demo || self.mode.testing {
            return Ok(());
        }
        let next = (self.prefs()["launchAtLogin"] == true, std::env::current_exe().map_err(|e| e.to_string())?);
        if self.login.borrow().as_ref() == Some(&next) {
            return Ok(());
        }
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let run = hkcu.create_subkey(r"Software\Microsoft\Windows\CurrentVersion\Run").map_err(|e| e.to_string())?.0;
        let approved = hkcu.create_subkey(r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run").map_err(|e| e.to_string())?.0;
        // Electron registered this item under its app id, or under "electron.app.Still" before the id was set.
        for name in [APP_ID, "electron.app.Still"] {
            let _ = run.delete_value(name);
            let _ = approved.delete_value(name);
        }
        if next.0 {
            run.set_value(APP_ID, &format!("\"{}\"", next.1.display())).map_err(|e| e.to_string())?;
            approved.set_raw_value(APP_ID, &RegValue { bytes: vec![2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0].into(), vtype: REG_BINARY }).map_err(|e| e.to_string())?;
        }
        *self.login.borrow_mut() = Some(next);
        Ok(())
    }

    /// Keeps one Task Scheduler entry at the next alert (30 s early, so Still is ready) while "Alarms after you quit" is on.
    pub fn schedule_wake(self: &Rc<Self>, at: Option<Option<i64>>) {
        if let Some(at) = at {
            self.next_alert_at.set(at);
        }
        if self.mode.demo {
            return;
        }
        let next = match (self.prefs()["alertsAfterQuit"] == true, self.next_alert_at.get()) {
            (true, Some(at)) => WakeAt::At(at - 30_000),
            _ => WakeAt::Off,
        };
        if next == self.wake_at.get() {
            return;
        }
        self.wake_at.set(next);
        let this = self.clone();
        spawn_local(async move {
            let _turn = this.wake_queue.lock().await;
            let schtasks = PathBuf::from(std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into())).join(r"System32\schtasks.exe");
            let task = if this.mode.testing { "Still Alerts Test" } else { "Still Alerts" };
            let outcome: Result<(), String> = async {
                match next {
                    WakeAt::At(at) => {
                        let file = this.mode.user_data.join("alerts-wake-task.xml");
                        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
                        let test_dir = this.mode.testing.then(|| this.mode.user_data.clone());
                        let args = wake_args(test_dir.as_deref()).into_iter().map(|a| if a.contains(|c: char| c.is_whitespace() || c == '"') { format!("\"{a}\"") } else { a }).collect::<Vec<_>>().join(" ");
                        let xml = wake_task_xml(&chrono::Local, at, &exe.to_string_lossy(), &args);
                        let bytes: Vec<u8> = std::iter::once(0xFEFFu16).chain(xml.encode_utf16()).flat_map(u16::to_le_bytes).collect();
                        std::fs::write(&file, bytes).map_err(|e| e.to_string())?;
                        run_schtasks(&schtasks, &["/Create", "/TN", task, "/XML", &file.to_string_lossy(), "/F"]).await
                    }
                    _ => {
                        let _ = run_schtasks(&schtasks, &["/Delete", "/TN", task, "/F"]).await;
                        Ok(())
                    }
                }
            }
            .await;
            if let Err(error) = outcome {
                if this.wake_at.get() == next {
                    this.wake_at.set(WakeAt::Unset); // Retry on the next change.
                }
                this.alert_error(format!("Windows could not schedule alerts to ring after Still quits: {error}"));
            }
        });
    }

    // ---- protection service ----

    async fn elevate(self: &Rc<Self>, command: &str) -> Result<Value, String> {
        self.guard.invalidate();
        if self.mode.demo {
            self.demo.borrow_mut().installed = command == "install";
            return Ok(self.status(false).await);
        }
        let install = command == "install";
        let file = if install { self.guard_dir().join("Still.Guard.exe") } else { self.program_files().join("Still Guard").join("Still.Guard.exe") };
        if !file.exists() {
            return Err(format!("ENOENT: no such file or directory, access '{}'", file.display()));
        }
        if !self.mode.packaged && install {
            // A source build keeps the policy script in the repository's native folder.
            let _ = std::fs::copy(exe_dir().join("../../native/policy.ps1"), self.guard_dir().join("policy.ps1"));
        }
        let args = if install { format!("--install {}", win::current_user_sid()?) } else { "--uninstall".to_string() };
        let ran = tokio::task::spawn_blocking(move || win::run_elevated(&file, &args)).await.map_err(|e| e.to_string())?;
        self.guard.invalidate();
        match ran {
            Ok(0) => {}
            Ok(_) => return Err("Protection setup did not finish. Check the Windows message and try again.".into()),
            Err(e) if e.raw_os_error() == Some(1223) => return Err("This command cannot be run due to the error: The operation was canceled by the user.".into()),
            Err(_) => return Err("Windows administrator permission was cancelled or setup failed.".into()),
        }
        if install {
            for _ in 0..15 {
                let result = self.status(false).await;
                if result["installed"] == true {
                    return Ok(result);
                }
                sleep(Duration::from_secs(1)).await;
            }
        }
        Ok(self.status(false).await)
    }

    /// Makes sure the installed Still Guard matches the one shipped with this app (updates need a new administrator approval).
    async fn guard_is_current(&self) -> bool {
        let (bundled, installed) = (self.guard_dir(), self.program_files().join("Still Guard"));
        let same = |file: &'static str| {
            let (a, b) = (bundled.join(file), installed.join(file));
            tokio::task::spawn_blocking(move || matches!((std::fs::read(a), std::fs::read(b)), (Ok(x), Ok(y)) if x == y))
        };
        let (policy, exe) = (same("policy.ps1"), same("Still.Guard.exe"));
        policy.await.unwrap_or(false) && exe.await.unwrap_or(false)
    }

    pub async fn start_session(self: &Rc<Self>, request: Value, scheduled: bool) -> Result<Value, String> {
        self.guard.invalidate();
        let mut value = domain::validate_session(&request)?;
        if scheduled {
            let ends = request["scheduledEndsAt"].as_i64().filter(|n| request["scheduledEndsAt"].is_i64() && n.abs() < (1 << 53));
            match ends {
                Some(ends) if ends > now_ms() && ends <= now_ms() + 90_000_000 => value["scheduledEndsAt"] = json!(ends),
                _ => return Err("The scheduled focus window has ended or is too long.".into()),
            }
        }
        if !self.mode.demo {
            // Scheduled alerts never trigger an unattended administrator prompt.
            if !scheduled && !self.guard_is_current().await {
                self.elevate("install").await?;
            }
            let mut command = value.as_object().cloned().unwrap_or_default();
            command.insert("command".into(), json!("start"));
            return self.guard.mutate(Value::Object(command)).await.map_err(|e| e.message);
        }
        {
            let mut demo = self.demo.borrow_mut();
            if !demo.installed {
                return Err("Enable preview protection first.".into());
            }
            if demo.session.is_some() {
                return Err("A session is already running.".into());
            }
            let mut session = value.as_object().cloned().unwrap_or_default();
            let ends = value["scheduledEndsAt"].as_i64().unwrap_or_else(|| now_ms() + value["durationMinutes"].as_i64().unwrap_or(0) * 60_000);
            session.insert("id".into(), json!(uuid::Uuid::new_v4().to_string()));
            session.insert("startedAt".into(), json!(now_ms()));
            session.insert("endsAt".into(), json!(ends));
            session.insert("unlockAt".into(), json!(0));
            session.insert("phase".into(), json!("active"));
            demo.session = Some(session);
        }
        Ok(self.status(false).await)
    }

    async fn session_command(self: &Rc<Self>, command: &str) -> Result<Value, String> {
        if !self.mode.demo {
            return self.guard.mutate(json!({ "command": command })).await.map_err(|e| e.message);
        }
        self.guard.invalidate();
        {
            let mut demo = self.demo.borrow_mut();
            let Some(session) = demo.session.as_mut() else { return Err("No active session.".into()) };
            let delay = session["unlockDelayMinutes"].as_i64().unwrap_or(0);
            let unlock_at = session.get("unlockAt").and_then(Value::as_i64).unwrap_or(0);
            match command {
                "requestUnlock" if unlock_at == 0 => {
                    session.insert("unlockAt".into(), json!(now_ms() + delay * 60_000));
                }
                "cancelUnlock" => {
                    session.insert("unlockAt".into(), json!(0));
                }
                "end" => {
                    if delay > 0 && (unlock_at == 0 || now_ms() < unlock_at) {
                        return Err("The release waiting period has not finished.".into());
                    }
                    drop(demo);
                    self.finish_demo("ended-early");
                }
                _ => {}
            }
        }
        Ok(self.status(false).await)
    }

    /// Releases an alarm's apps when it is snoozed.
    pub async fn snooze_session(self: &Rc<Self>, id: &str) -> Result<Value, String> {
        if !self.mode.demo {
            return self.guard.mutate(json!({ "command": "snooze", "id": id })).await.map_err(|e| e.message);
        }
        self.guard.invalidate();
        let snoozing = self.demo.borrow().session.as_ref().is_some_and(|s| s["id"] == id);
        if snoozing {
            if self.demo.borrow().session.as_ref().is_some_and(|s| s.get("scheduledEndsAt").and_then(Value::as_i64).unwrap_or(0) == 0) {
                return Err("Only an alarm session can be snoozed.".into());
            }
            self.finish_demo("snoozed");
        }
        Ok(self.status(false).await)
    }

    /// Alerts that block need an up-to-date Still Guard; this offers to prepare or update it.
    pub async fn prepare_protection(self: &Rc<Self>) -> Result<(), String> {
        let ready = |s: &Value| s["installed"] == true && s.get("unavailable") != Some(&Value::Bool(true)) && (s["demo"] == true || (s["scheduledAlerts"] == true && s["snoozeAlerts"] == true && s["websiteBlocking"] == true));
        let current = self.status(false).await;
        if ready(&current) {
            return Ok(());
        }
        if !current["session"].is_null() {
            return Err("Finish your current focus session before updating Windows protection for alerts.".into());
        }
        let current = self.elevate("install").await?;
        if !ready(&current) {
            return Err("Scheduled app blocking is not ready. Prepare / update app blocking and try saving again.".into());
        }
        Ok(())
    }

    async fn update_history(self: &Rc<Self>, id: &Value, action: &Value) -> Result<Value, String> {
        let (Some(id), Some(action)) = (id.as_str().filter(|i| !i.is_empty() && i.chars().count() <= 100), action.as_str().filter(|a| ["archive", "restore", "delete"].contains(a))) else {
            return Err("Invalid history action.".into());
        };
        if id.starts_with("alarm-") {
            let alerts = self.alerts.borrow().clone().ok_or("Saved session not found.")?;
            alerts.update_focus(id, action).await?;
            return Ok(self.status(false).await);
        }
        if !self.mode.demo {
            let command = json!({ "command": "updateHistory", "id": id, "action": action });
            return match self.guard.mutate(command.clone()).await {
                Ok(value) => Ok(self.with_alarm_focus(value)),
                Err(error) if error.message == "Unknown command." => {
                    let current = self.status(false).await;
                    if current.get("unavailable") == Some(&Value::Bool(true)) || !current["session"].is_null() {
                        return Err("Finish your current session, then try again to update Windows protection for session management.".into());
                    }
                    self.elevate("install").await?;
                    self.guard.mutate(command).await.map(|v| self.with_alarm_focus(v)).map_err(|e| e.message)
                }
                Err(error) => Err(error.message),
            };
        }
        self.guard.invalidate();
        {
            let mut demo = self.demo.borrow_mut();
            let Some(index) = demo.history.iter().position(|s| s["id"] == id) else { return Err("Saved session not found.".into()) };
            if action == "delete" {
                demo.history.remove(index);
            } else {
                demo.history[index]["archived"] = json!(action == "archive");
            }
            demo.revision = uuid::Uuid::new_v4().to_string();
        }
        Ok(self.status(false).await)
    }

    // ---- dialogs, updates, export ----

    async fn browse(self: &Rc<Self>) -> Result<Value, String> {
        let picked = match self.test_pick() {
            Some(files) => Some(files),
            None => rfd::AsyncFileDialog::new()
                .set_title("Choose apps or games to block")
                .add_filter("Windows applications", &["exe"])
                .set_parent(&win::main_parent())
                .pick_files()
                .await
                .map(|files| files.iter().map(|f| f.path().to_path_buf()).collect()),
        };
        let Some(files) = picked else { return Ok(json!([])) };
        let apps: Vec<Value> = files
            .iter()
            .map(|path| json!({ "name": path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default(), "path": path.to_string_lossy() }))
            .collect();
        if apps.iter().any(|a| !domain::allowed_app(a)) {
            return Err("Windows components and Still cannot be blocked. Choose a desktop app or game.".into());
        }
        Ok(Value::Array(apps::enrich(&apps).await))
    }

    async fn check_for_updates(self: &Rc<Self>) -> Result<Value, String> {
        let unreachable = || "Could not reach GitHub. Check your connection and try again.".to_string();
        let (status, _, body) = http_get("https://api.github.com/repos/limpy183-dev/Still/releases/latest", Duration::from_secs(15), 4 << 20, "application/vnd.github+json").await.map_err(|_| unreachable())?;
        if !(200..300).contains(&status) {
            return Err(unreachable());
        }
        let release: Value = serde_json::from_slice(&body).map_err(|_| unreachable())?;
        let latest = release["tag_name"].as_str().unwrap_or("").trim_start_matches('v').to_string();
        let asset = release["assets"].as_array().and_then(|assets| {
            assets.iter().find(|a| {
                let name = a["name"].as_str().unwrap_or("");
                name.strip_prefix("Still-Setup-").and_then(|n| n.strip_suffix(".exe")).is_some_and(|v| !v.is_empty() && v.chars().all(|c| c.is_ascii_digit() || c == '.'))
            })
        });
        *self.download_url.borrow_mut() = Some(domain::update_url(asset.and_then(|a| str_of(a.get("browser_download_url")))));
        Ok(json!({ "current": self.version(), "latest": latest, "newer": domain::newer_version(&latest, self.version()) }))
    }

    async fn export_history(self: &Rc<Self>) -> Result<Value, String> {
        let current = self.status(true).await;
        if current.get("unavailable") == Some(&Value::Bool(true)) {
            return Err("Reconnect Windows protection before exporting your saved history.".into());
        }
        let Some(file) = rfd::AsyncFileDialog::new().set_file_name("Still-sessions.json").add_filter("JSON", &["json"]).set_parent(&win::main_parent()).save_file().await else {
            return Ok(json!(false));
        };
        let text = serde_json::to_string_pretty(&current["history"]).map_err(|e| e.to_string())?;
        tokio::fs::write(file.path(), text).await.map_err(|e| e.to_string())?;
        Ok(json!(true))
    }
}

async fn run_schtasks(schtasks: &Path, args: &[&str]) -> Result<(), String> {
    let output = tokio::time::timeout(
        Duration::from_secs(20),
        tokio::process::Command::new(schtasks).args(args).creation_flags(CREATE_NO_WINDOW).kill_on_drop(true).output(),
    )
    .await
    .map_err(|_| "Command timed out.".to_string())?
    .map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!("Command failed: schtasks.exe {}\n{}", args.join(" "), String::from_utf8_lossy(&output.stderr).trim()))
    }
}

/// A small blocking-HTTP helper run off the logic thread: `(status, content type, body)`.
pub async fn http_get(url: &str, limit: Duration, max_bytes: u64, accept: &str) -> Result<(u16, String, Vec<u8>), String> {
    let (url, accept) = (url.to_string(), accept.to_string());
    tokio::task::spawn_blocking(move || {
        use ureq::tls::{RootCerts, TlsConfig};
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .timeout_global(Some(limit))
            .http_status_as_error(false)
            .user_agent(concat!("Still/", env!("CARGO_PKG_VERSION")))
            .tls_config(TlsConfig::builder().root_certs(RootCerts::PlatformVerifier).build())
            .build()
            .into();
        let mut response = agent.get(&url).header("accept", accept).call().map_err(|e| e.to_string())?;
        let status = response.status().as_u16();
        let content_type = response.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
        let body = response.body_mut().with_config().limit(max_bytes).read_to_vec().map_err(|e| e.to_string())?;
        Ok((status, content_type, body))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_things_survive_an_older_still_rewriting_preferences() {
        let dir = std::env::temp_dir().join(format!("still-new-things-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let write = |text: &str| write_atomic(&dir.join("preferences.json"), text).unwrap();
        let things = |p: &Preferences| p.value["newThings"].as_array().unwrap().len();

        write(r#"{"newThings":[{"text":"Learned to juggle","day":"2026-10-30","done":false}],"todos":[]}"#);
        assert_eq!(things(&Preferences::load(&dir)), 1, "the list loads and is copied aside");
        write(r#"{"todos":[{"text":"kept","type":"checkbox","done":false}]}"#); // what Still 1.1.6 writes
        let back = Preferences::load(&dir);
        assert_eq!((things(&back), back.value["todos"][0]["text"].as_str()), (1, Some("kept")), "restored, the rest untouched");
        write("not json");
        let _ = Preferences::load(&dir);
        write(r#"{"newThings":[]}"#);
        assert_eq!(things(&Preferences::load(&dir)), 0, "an unreadable file never overwrites the copy, and an emptied list stays empty");
        write("{}");
        assert_eq!(things(&Preferences::load(&dir)), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
