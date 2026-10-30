//! The alerts engine, ported from `app/alerts-main.cjs`: saved alerts, the 2-second scheduler, alarm windows and
//! toasts, snoozing, scheduled blocking and "Let's focus" history. Everything runs on the logic thread; the only
//! operations that wait their turn (the original's `serial` queue) are those that change saved alerts.
use crate::{
    app::{APP_ID, App, write_atomic},
    ui::{AlarmWindow, CoreMsg, UiEvent, WindowKey, emit_script},
    win::{self, Toast, ToastEvent},
};
use chrono::Local;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::{
    cell::RefCell,
    collections::VecDeque,
    io::Read,
    path::{Path, PathBuf},
    rc::{Rc, Weak},
    time::Duration,
};
use still_core::{
    alerts::{Alert, MEDIA_FILE, Occurrence, Pending, due_occurrence, next_occurrence, skip_ended, validate_alert},
    domain,
    js::{prop, str_of},
    session::{TargetApp, now_ms},
};
use tokio::{task::{JoinHandle, spawn_local}, time::sleep};

const SOUND_EXT: [&str; 9] = ["mp3", "wav", "ogg", "m4a", "aac", "flac", "mp4", "mov", "webm"];
const BANNER_EXT: [&str; 8] = ["png", "jpg", "jpeg", "gif", "webp", "mp4", "mov", "webm"];
const ENDED: &str = "This focus window has ended. This is a reminder only; scheduled blocking has ended.";

/// One alarm waiting to be shown, or being shown.
#[derive(Clone)]
struct Presentation {
    alert: Alert,
    occurrence: Occurrence,
    missed: bool,
    message: String,
    preview: bool,
}

struct Active {
    serial: u64,
    item: Presentation,
    /// Window ids; the first is the audible one.
    windows: Vec<u64>,
    toast: Option<Toast>,
    timeout: JoinHandle<()>,
}

#[derive(Default)]
struct State {
    records: Vec<Alert>,
    committed: Vec<Alert>,
    focus: Vec<Value>,
    focus_revision: String,
    ticking: bool,
    active: Option<Active>,
    presentations: VecDeque<Presentation>,
    serial: u64,
    window: u64,
}

pub struct Alerts {
    app: Weak<App>,
    dir: PathBuf,
    store: PathBuf,
    focus_store: PathBuf,
    sounds_dir: PathBuf,
    icon: PathBuf,
    queue: tokio::sync::Mutex<()>,
    st: RefCell<State>,
}

fn read_json(file: &Path) -> Result<Option<Value>, String> {
    match std::fs::read_to_string(file) {
        Ok(text) => serde_json::from_str(&text).map(Some).map_err(|e| e.to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Keeps a malformed file for recovery instead of silently overwriting it.
fn keep_for_recovery(file: &Path, error: &str) {
    let _ = std::fs::copy(file, format!("{}.recovery-{}", file.display(), now_ms()));
    eprintln!("{} could not be loaded. A recovery copy was retained. {error}", file.display());
}

fn alert_from(map: Map<String, Value>) -> Result<Alert, String> {
    serde_json::from_value(Value::Object(map)).map_err(|e| e.to_string())
}

fn merged(base: &Alert, validated: &Value) -> Result<Alert, String> {
    let mut map = serde_json::to_value(base).ok().and_then(|v| v.as_object().cloned()).unwrap_or_default();
    map.extend(validated.as_object().cloned().unwrap_or_default());
    alert_from(map)
}

impl Alerts {
    pub async fn setup(app: &Rc<App>) -> Rc<Alerts> {
        let data = &app.mode.user_data;
        let alerts = Rc::new(Alerts {
            app: Rc::downgrade(app),
            dir: data.join("alert-media"),
            store: data.join("alerts.json"),
            focus_store: data.join("alarm-focus.json"),
            sounds_dir: data.join("AlertSounds"),
            icon: data.join("toast-icon.png"),
            queue: tokio::sync::Mutex::new(()),
            st: RefCell::new(State { focus_revision: uuid::Uuid::new_v4().to_string(), ..Default::default() }),
        });
        let _ = std::fs::create_dir_all(&alerts.dir);
        if !alerts.icon.exists() {
            if let Some(png) = crate::ui::ui_file("/assets/still.png") {
                let _ = std::fs::write(&alerts.icon, png);
            }
        }
        // Reminder-only alarms have no guard session; "Let's focus" can add their window to Progress.
        match read_json(&alerts.focus_store) {
            Ok(Some(Value::Array(items))) => {
                alerts.st.borrow_mut().focus = items
                    .into_iter()
                    .filter(|i| i["id"].as_str().is_some_and(|id| id.starts_with("alarm-")) && i["startedAt"].is_number() && i["endsAt"].is_number())
                    .collect();
            }
            Ok(_) => {}
            Err(error) => keep_for_recovery(&alerts.focus_store, &error),
        }
        let loaded = read_json(&alerts.store).and_then(|saved| match saved {
            None => Ok(Vec::new()),
            Some(Value::Array(list)) => list
                .into_iter()
                .take(100)
                .map(|record| {
                    let validated = validate_alert(&record)?;
                    let mut map = record.as_object().cloned().unwrap_or_default();
                    map.extend(validated.as_object().cloned().unwrap_or_default());
                    alert_from(map)
                })
                .collect(),
            Some(_) => Err("Invalid alerts file.".into()),
        });
        match loaded {
            Ok(records) => {
                let mut st = alerts.st.borrow_mut();
                st.committed = records.clone();
                st.records = records;
            }
            Err(error) => keep_for_recovery(&alerts.store, &error),
        }
        alerts.next_alert();
        let ticker = alerts.clone();
        spawn_local(async move {
            loop {
                sleep(Duration::from_secs(2)).await;
                ticker.schedule_tick();
            }
        });
        alerts
    }

    fn app(&self) -> Rc<App> {
        self.app.upgrade().expect("the app outlives its alerts")
    }

    async fn serial<T>(&self, action: impl std::future::Future<Output = T>) -> T {
        let _turn = self.queue.lock().await;
        action.await
    }

    /// The alerts as the page sees them, with the next time each rings.
    fn list(&self) -> Vec<Value> {
        let st = self.st.borrow();
        let now = now_ms();
        st.records
            .iter()
            .map(|record| {
                let snooze = record.snooze_at.filter(|s| *s != 0);
                let next = [snooze, next_occurrence(&Local, record, now)].into_iter().flatten().min();
                let mut value = serde_json::to_value(record).unwrap_or_default();
                value["nextAt"] = if record.enabled { next.map_or(Value::Null, Value::from) } else { Value::Null };
                value["ringing"] = json!(st.active.as_ref().is_some_and(|a| a.item.alert.id == record.id && !a.item.preview));
                value["queued"] = json!(st.presentations.iter().any(|p| p.alert.id == record.id && !p.preview));
                value
            })
            .collect()
    }

    fn notify(&self) {
        self.app().emit("alerts-changed", &Value::Array(self.list()));
    }

    fn next_alert(&self) {
        let next = self.list().iter().filter_map(|r| r["nextAt"].as_i64()).min();
        self.app().schedule_wake(Some(next));
    }

    fn commit(&self, index: usize, record: &Alert) {
        if let Some(slot) = self.st.borrow_mut().records.get_mut(index) {
            *slot = record.clone();
        }
    }

    /// Saves `next` (or the in-memory alerts). If the save fails, memory returns to the last saved state.
    async fn persist(&self, next: Option<Vec<Alert>>) -> Result<(), String> {
        let list = next.unwrap_or_else(|| self.st.borrow().records.clone());
        let text = serde_json::to_string_pretty(&list).map_err(|e| e.to_string())?;
        let store = self.store.clone();
        let saved = tokio::task::spawn_blocking(move || write_atomic(&store, &text)).await.map_err(|e| e.to_string())?;
        match saved {
            Ok(()) => {
                {
                    let mut st = self.st.borrow_mut();
                    st.committed = list.clone();
                    st.records = list;
                }
                self.notify();
                self.next_alert();
                Ok(())
            }
            Err(error) => {
                let mut st = self.st.borrow_mut();
                st.records = st.committed.clone();
                Err(error.to_string())
            }
        }
    }

    async fn save_focus(&self, next: Vec<Value>) -> Result<(), String> {
        let text = serde_json::to_string_pretty(&next).map_err(|e| e.to_string())?;
        let store = self.focus_store.clone();
        tokio::task::spawn_blocking(move || write_atomic(&store, &text)).await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())?;
        let mut st = self.st.borrow_mut();
        st.focus = next;
        st.focus_revision = uuid::Uuid::new_v4().to_string();
        Ok(())
    }

    /// Only finished windows count, like completed sessions.
    pub fn focus_history(&self, now: i64) -> (Vec<Value>, String) {
        let st = self.st.borrow();
        let done: Vec<Value> = st.focus.iter().filter(|i| i["finishedAt"].as_i64().is_some_and(|f| f <= now)).cloned().collect();
        let revision = format!("{}:{}", st.focus_revision, done.len());
        (done, revision)
    }

    pub async fn update_focus(&self, id: &str, action: &str) -> Result<(), String> {
        self.serial(async {
            let current = self.st.borrow().focus.clone();
            if !current.iter().any(|i| i["id"] == id) {
                return Err("Saved session not found.".to_string());
            }
            let next = if action == "delete" {
                current.into_iter().filter(|i| i["id"] != id).collect()
            } else {
                current.into_iter().map(|mut i| { if i["id"] == id { i["archived"] = json!(action == "archive"); } i }).collect()
            };
            self.save_focus(next).await
        })
        .await
    }

    // ---- presenting alarms ----

    fn present(self: &Rc<Self>, alert: Alert, occurrence: Occurrence, missed: bool, message: String, preview: bool) -> Result<(), String> {
        if preview && self.st.borrow().presentations.len() >= 10 {
            return Err("Close an alarm preview before opening another.".into());
        }
        self.st.borrow_mut().presentations.push_back(Presentation { alert, occurrence, missed, message, preview });
        self.show_next();
        Ok(())
    }

    fn show_next(self: &Rc<Self>) {
        let app = self.app();
        let mut item = {
            let mut st = self.st.borrow_mut();
            if st.active.is_some() {
                return;
            }
            let Some(item) = st.presentations.pop_front() else { return };
            item
        };
        if !item.preview && !item.missed {
            item.message = if item.occurrence.end <= now_ms() {
                ENDED.to_string()
            } else {
                self.st.borrow().records.iter().find(|r| r.id == item.alert.id).and_then(|r| r.last_result.clone()).filter(|m| !m.is_empty()).unwrap_or(item.message)
            };
        }
        let alert = &item.alert;
        let quiet = alert.style == "notification";
        let silent = quiet && (alert.sound == "silent" || alert.volume == 0.0);
        let displays = if silent { Vec::new() } else if alert.style == "full" { win::all_displays() } else { vec![win::cursor_display()] };
        let mut windows = Vec::new();
        for display in displays {
            let (area, scale) = (display.work, display.scale);
            let rect = if alert.style == "full" {
                display.bounds
            } else {
                let (card_w, card_h) = ((460.0 * scale) as i32, (610.0 * scale) as i32);
                let margin = (16.0 * scale) as i32;
                win::Area { x: area.x + (area.w - card_w - margin).max(0), y: area.y + (area.h - card_h - margin).max(0), w: card_w.min(area.w), h: card_h.min(area.h) }
            };
            let id = {
                let mut st = self.st.borrow_mut();
                st.window += 1;
                st.window
            };
            windows.push(id);
            let _ = app.ui.send_event(UiEvent::OpenAlarm(AlarmWindow { id, area: rect, full: alert.style == "full", on_top: alert.on_top }));
        }
        let serial = {
            let mut st = self.st.borrow_mut();
            st.serial += 1;
            st.serial
        };
        let mut toast = None;
        if quiet {
            let title = if item.preview { format!("Preview · {}", alert.title) } else { alert.title.clone() };
            let body = [alert.note.as_str(), item.message.as_str()].iter().filter(|s| !s.is_empty()).copied().collect::<Vec<_>>().join("\n");
            let tx = app.tx.clone();
            match win::show_toast(APP_ID, &title, &body, Some(&self.icon), true, move |event| {
                let _ = tx.send(CoreMsg::Toast(serial, event));
            }) {
                Ok(shown) => toast = Some(shown),
                Err(_) => {
                    app.alert_error("Windows could not show the notification. Check Windows notification settings.");
                    let this = self.clone();
                    spawn_local(async move { this.close_presentation_if(serial) });
                }
            }
        }
        let this = self.clone();
        let timeout = spawn_local(async move {
            sleep(if quiet { Duration::from_secs(10) } else { Duration::from_secs(300) }).await;
            this.close_presentation_if(serial);
        });
        self.st.borrow_mut().active = Some(Active { serial, item, windows, toast, timeout });
        self.notify();
    }

    fn close_presentation_if(self: &Rc<Self>, serial: u64) {
        if self.st.borrow().active.as_ref().is_some_and(|a| a.serial == serial) {
            self.close_presentation();
        }
    }

    fn close_presentation(self: &Rc<Self>) {
        let Some(previous) = self.st.borrow_mut().active.take() else { return };
        previous.timeout.abort();
        if let Some(toast) = &previous.toast {
            toast.hide();
        }
        let app = self.app();
        for id in &previous.windows {
            let _ = app.ui.send_event(UiEvent::CloseAlarm(*id));
        }
        self.notify();
        let this = self.clone();
        spawn_local(async move {
            sleep(Duration::from_millis(150)).await;
            this.show_next();
        });
    }

    pub fn close_all(self: &Rc<Self>) {
        self.st.borrow_mut().presentations.clear();
        self.close_presentation();
    }

    fn send_alarm_status(&self, text: &str) {
        let app = self.app();
        let ids = {
            let mut st = self.st.borrow_mut();
            let Some(active) = st.active.as_mut() else { return };
            active.item.message = text.to_string();
            active.windows.clone()
        };
        for id in ids {
            let _ = app.ui.send_event(UiEvent::Eval(WindowKey::Alarm(id), emit_script("alarm-message", &json!(text))));
        }
    }

    /// An alarm page has loaded: give it its data, then show it.
    pub fn window_ready(&self, id: u64) {
        let app = self.app();
        let prefs = app.prefs();
        let data = {
            let st = self.st.borrow();
            let Some(active) = st.active.as_ref() else { return };
            let Some(index) = active.windows.iter().position(|w| *w == id) else { return };
            let item = &active.item;
            let mut occurrence = json!({ "start": item.occurrence.start, "end": item.occurrence.end });
            if item.missed {
                occurrence["missed"] = json!(true);
            }
            json!({ "alert": item.alert, "occurrence": occurrence, "message": item.message, "preview": item.preview, "audible": index == 0, "reducedMotion": prefs["reducedMotion"], "accessibility": *prefs })
        };
        let _ = app.ui.send_event(UiEvent::Eval(WindowKey::Alarm(id), emit_script("alarm-data", &data)));
        // A quiet notification keeps its window hidden: it only plays the sound.
        if self.st.borrow().active.as_ref().is_some_and(|a| a.item.alert.style != "notification") {
            let _ = app.ui.send_event(UiEvent::ShowAlarm(id));
        }
    }

    pub fn window_closed(self: &Rc<Self>, id: u64) {
        if self.st.borrow().active.as_ref().is_some_and(|a| a.windows.contains(&id)) {
            self.close_presentation();
        }
    }

    pub fn toast_event(self: &Rc<Self>, serial: u64, event: ToastEvent) {
        if !self.st.borrow().active.as_ref().is_some_and(|a| a.serial == serial) {
            return;
        }
        let app = self.app();
        match event {
            ToastEvent::Click => {
                let _ = app.ui.send_event(UiEvent::ShowMain);
            }
            ToastEvent::Failed(detail) => {
                eprintln!("Notification failed: {detail}");
                app.alert_error("Windows could not show the notification. Check Windows notification settings.");
            }
            ToastEvent::Closed => {}
        }
        self.close_presentation();
    }

    pub async fn alarm_action(self: &Rc<Self>, window: u64, action: &Value) -> Result<Value, String> {
        let app = self.app();
        let presentation = {
            let st = self.st.borrow();
            match st.active.as_ref() {
                Some(a) if a.windows.contains(&window) => (a.serial, a.item.clone()),
                _ => return Err("Untrusted alarm request.".into()),
            }
        };
        let (serial, item) = presentation;
        let action = action.as_str().filter(|a| ["dismiss", "snooze", "open"].contains(a)).ok_or("Unknown alarm action.")?;
        if action == "dismiss" && !item.preview && !item.alert.show_dismiss {
            return Err("Dismiss is hidden for this alarm.".into());
        }
        let still_active = |this: &Self| this.st.borrow().active.as_ref().is_some_and(|a| a.serial == serial);
        if action == "snooze" && !item.preview {
            self.serial(async {
                if !still_active(self) {
                    return Ok(());
                }
                let record = self.st.borrow().records.iter().find(|r| r.id == item.alert.id).cloned().ok_or("Alert not found.")?;
                if record.snooze_limit.is_some_and(|limit| record.snooze_count.unwrap_or(0) >= limit) {
                    return Err("No snoozes remaining.".to_string());
                }
                if let Some(session) = record.session_id() {
                    app.snooze_session(session).await?;
                }
                let next = self.st.borrow().records.iter().map(|r| {
                    if r.id != item.alert.id {
                        return r.clone();
                    }
                    Alert {
                        snooze_count: Some(r.snooze_count.unwrap_or(0) + 1),
                        session_id: Some(None),
                        pending: Some(None),
                        snooze_at: Some(now_ms() + 5 * 60_000),
                        snooze_end: Some(item.occurrence.end),
                        last_result: Some("Snoozed · this alarm’s apps are unblocked.".into()),
                        ..r.clone()
                    }
                }).collect();
                self.persist(Some(next)).await
            })
            .await?;
        }
        if action == "open" && !item.preview && app.prefs()["countAlarmFocus"] == true {
            self.serial(async {
                let record = self.st.borrow().records.iter().find(|r| r.id == item.alert.id).cloned();
                let (now, end) = (now_ms(), item.occurrence.end);
                // Alarms that start blocking already count through their focus session.
                let Some(record) = record.filter(|r| r.session_id().is_none() && r.pending().is_none() && end > now) else { return Ok(()) };
                let id = format!("alarm-{}-{}", record.id, record.last_occurrence());
                if self.st.borrow().focus.iter().any(|i| i["id"] == id) {
                    return Ok(());
                }
                let entry = json!({ "id": id, "alarm": true, "intention": record.title, "apps": [], "startedAt": now, "endsAt": end, "finishedAt": end, "durationMinutes": (end - now + 59_999) / 60_000, "outcome": "completed" });
                let mut next = vec![entry];
                next.extend(self.st.borrow().focus.iter().cloned());
                next.truncate(500);
                self.save_focus(next).await
            })
            .await?;
        }
        if action == "open" {
            let _ = app.ui.send_event(UiEvent::ShowMain);
        }
        if still_active(self) {
            self.close_presentation();
        }
        Ok(json!(true))
    }

    // ---- requests from the page ----

    pub async fn handle(self: &Rc<Self>, name: &str, arg: Value) -> Result<Value, String> {
        match name {
            "alerts:list" => Ok(Value::Array(self.list())),
            "alerts:save" => self.serial(self.save(&arg)).await,
            "alerts:toggle" => self.serial(self.toggle(&arg)).await,
            "alerts:delete" => {
                self.serial(async {
                    let next = self.st.borrow().records.iter().filter(|r| arg.as_str() != Some(r.id.as_str())).cloned().collect();
                    self.persist(Some(next)).await?;
                    let id = arg.as_str().unwrap_or_default();
                    self.st.borrow_mut().presentations.retain(|p| p.alert.id != id);
                    if self.st.borrow().active.as_ref().is_some_and(|a| a.item.alert.id == id) {
                        self.close_presentation();
                    }
                    Ok(Value::Array(self.list()))
                })
                .await
            }
            "alerts:preview" => {
                let alert = alert_from(validate_alert(&arg)?.as_object().cloned().unwrap_or_default())?;
                let now = now_ms();
                let end = now + alert.duration_minutes * 60_000;
                self.present(alert, Occurrence { start: now, end }, false, "Preview only · no apps or websites will be blocked.".into(), true)?;
                Ok(json!(true))
            }
            "alerts:folderSounds" => {
                let dir = self.sounds_dir.clone();
                tokio::task::spawn_blocking(move || {
                    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
                    let mut names: Vec<String> = std::fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| extension(n).is_some_and(|e| SOUND_EXT.contains(&e.as_str()))).collect();
                    names.sort();
                    Ok(json!(names))
                })
                .await
                .map_err(|e| e.to_string())?
            }
            "alerts:folderSound" => {
                let name = arg.as_str().filter(|n| Path::new(n).file_name().is_some_and(|f| f == *n)).ok_or("Unknown sound.")?;
                self.import_media(self.sounds_dir.join(name), &SOUND_EXT).await
            }
            "alerts:openSoundsFolder" => {
                let _ = std::fs::create_dir_all(&self.sounds_dir);
                win::open_path(&self.sounds_dir);
                Ok(json!(true))
            }
            "alerts:media" => {
                let sound = match arg.as_str() {
                    Some("sound") => true,
                    Some("banner") => false,
                    _ => return Err("Unknown media type.".into()),
                };
                let extensions: &[&str] = if sound { &SOUND_EXT } else { &BANNER_EXT };
                let picked = match self.app().test_pick() {
                    Some(files) => files.into_iter().next(),
                    None => rfd::AsyncFileDialog::new()
                        .set_title(if sound { "Choose an alarm sound" } else { "Choose an image, GIF or video" })
                        .add_filter(if sound { "Audio & video" } else { "Images & videos" }, extensions)
                        .set_parent(&win::main_parent())
                        .pick_file()
                        .await
                        .map(|file| file.path().to_path_buf()),
                };
                match picked {
                    Some(file) => self.import_media(file, extensions).await,
                    None => Ok(Value::Null),
                }
            }
            _ => Err(format!("Unknown request: {name}")),
        }
    }

    async fn save(self: &Rc<Self>, value: &Value) -> Result<Value, String> {
        let validated = validate_alert(value)?;
        let alert = alert_from(validated.as_object().cloned().unwrap_or_default())?;
        let existing = self.st.borrow().records.iter().find(|r| value["id"].as_str() == Some(r.id.as_str())).cloned();
        if existing.is_none() && self.st.borrow().records.len() >= 100 {
            return Err("You can save up to 100 alerts.".into());
        }
        let now = now_ms();
        if alert.enabled && alert.repeat == "once" && next_occurrence(&Local, &Alert { last_occurrence: Some(0), ..alert.clone() }, now).is_none() {
            return Err("Choose a future time or a time range that is still active.".into());
        }
        for asset in [&alert.sound_file, &alert.banner].into_iter().flatten() {
            tokio::fs::metadata(self.dir.join(&asset.file)).await.map_err(|e| format!("ENOENT: {e}"))?;
        }
        if alert.enabled && alert.block_mode != "none" {
            self.app().prepare_protection().await?;
        }
        let schedule_changed = existing.as_ref().is_some_and(|e| {
            e.date != alert.date || e.time != alert.time || e.repeat != alert.repeat || e.length_mode != alert.length_mode || e.duration_minutes != alert.duration_minutes || e.end_time != alert.end_time
        });
        let mut record = merged(&existing.clone().unwrap_or_else(|| alert.clone()), &validated)?;
        record.id = existing.as_ref().map(|e| e.id.clone()).unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        record.snooze_at = Some(0);
        record.pending = Some(None);
        record.last_result = Some(existing.as_ref().and_then(|e| e.last_result.clone()).unwrap_or_default());
        let prior = if schedule_changed || existing.is_none() { 0 } else { existing.as_ref().map_or(0, Alert::last_occurrence) };
        record.last_occurrence = Some(skip_ended(&Local, &Alert { last_occurrence: Some(prior), ..record.clone() }, now));
        let records = self.st.borrow().records.clone();
        let next = if existing.is_some() { records.into_iter().map(|r| if r.id == record.id { record.clone() } else { r }).collect() } else { records.into_iter().chain([record]).collect() };
        self.persist(Some(next)).await?;
        Ok(Value::Array(self.list()))
    }

    async fn toggle(self: &Rc<Self>, id: &Value) -> Result<Value, String> {
        let record = self.st.borrow().records.iter().find(|r| id.as_str() == Some(r.id.as_str())).cloned().ok_or("Alert not found.")?;
        if !record.enabled && record.block_mode != "none" {
            self.app().prepare_protection().await?;
        }
        let now = now_ms();
        let next = self.st.borrow().records.iter().map(|r| {
            if r.id != record.id {
                return r.clone();
            }
            let last = if r.enabled { r.last_occurrence } else { Some(skip_ended(&Local, &Alert { enabled: true, ..r.clone() }, now)) };
            Alert { enabled: !r.enabled, snooze_at: Some(0), pending: Some(None), last_occurrence: last, ..r.clone() }
        }).collect();
        self.persist(Some(next)).await?;
        Ok(Value::Array(self.list()))
    }

    /// Copies a chosen file into alert-media, reusing an identical file already there (same size, then same hash).
    async fn import_media(&self, source: PathBuf, extensions: &'static [&'static str]) -> Result<Value, String> {
        let dir = self.dir.clone();
        tokio::task::spawn_blocking(move || {
            let name = source.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            let ext = extension(&name).unwrap_or_default();
            if !extensions.contains(&ext.as_str()) {
                return Err("This file type is not supported.".to_string());
            }
            let size = std::fs::metadata(&source).map_err(|e| e.to_string())?.len();
            if size > 200 * 1024 * 1024 {
                return Err("Choose a file smaller than 200 MB.".to_string());
            }
            let hash_of = |file: &Path| -> std::io::Result<String> {
                let mut reader = std::fs::File::open(file)?;
                let (mut hash, mut chunk) = (Sha256::new(), vec![0u8; 65536]);
                loop {
                    let read = reader.read(&mut chunk)?;
                    if read == 0 {
                        break;
                    }
                    hash.update(&chunk[..read]);
                }
                Ok(hash.finalize().iter().map(|b| format!("{b:02x}")).collect())
            };
            let digest = hash_of(&source).map_err(|e| e.to_string())?;
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
                let existing = entry.file_name().to_string_lossy().into_owned();
                if !MEDIA_FILE.is_match(&existing) || extension(&existing).as_deref() != Some(ext.as_str()) {
                    continue;
                }
                if entry.metadata().is_ok_and(|m| m.len() == size) && hash_of(&entry.path()).ok().as_deref() == Some(digest.as_str()) {
                    return Ok(json!({ "file": existing, "name": name }));
                }
            }
            let file = format!("{}.{ext}", &digest[..36]);
            std::fs::copy(&source, dir.join(&file)).map_err(|e| e.to_string())?;
            Ok(json!({ "file": file, "name": name }))
        })
        .await
        .map_err(|e| e.to_string())?
    }

    // ---- the scheduler ----

    fn schedule_tick(self: &Rc<Self>) {
        if std::mem::replace(&mut self.st.borrow_mut().ticking, true) {
            return;
        }
        let this = self.clone();
        spawn_local(async move {
            let result = this.serial(this.tick()).await;
            this.st.borrow_mut().ticking = false;
            if let Err(error) = result {
                this.app().alert_error(format!("Alerts could not be updated: {error}"));
            }
        });
    }

    async fn tick(self: &Rc<Self>) -> Result<(), String> {
        let app = self.app();
        let mut changed = false;
        // One status read is shared by every alert in a pass, while its session stays active.
        let mut cached: Option<(Value, i64, u64)> = None;
        let count = self.st.borrow().records.len();
        for index in 0..count {
            let Some(mut record) = self.st.borrow().records.get(index).cloned() else { break };
            if !record.enabled {
                continue;
            }
            let now = now_ms();
            if record.snooze_at.is_some_and(|s| s != 0 && s <= now) {
                let end = record.snooze_end.unwrap_or(now + 1);
                if end <= now {
                    record.last_result = Some(ENDED.into());
                } else if let Some(apps) = record.occurrence_apps.clone().filter(|a| !a.is_empty()) {
                    record.pending = Some(Some(Pending { start: now, end, apps }));
                    record.last_result = Some("Waiting to restart blocking…".into());
                }
                record.snooze_at = Some(0);
                self.commit(index, &record);
                self.persist(None).await?;
                let message = if end <= now { "Your focus window has ended. This is your snoozed reminder.".to_string() } else { record.last_result.clone().filter(|m| !m.is_empty()).unwrap_or_else(|| "Your reminder, a little later.".into()) };
                let _ = self.present(record.clone(), Occurrence { start: now, end }, false, message, false);
            }
            if let Some(occurrence) = due_occurrence(&Local, &record, now) {
                record.last_occurrence = Some(occurrence.start);
                record.snooze_count = Some(0);
                record.snooze_at = Some(0);
                record.session_id = Some(None);
                if occurrence.end <= now {
                    // Ring late rather than never; a missed focus window never starts blocking.
                    record.pending = Some(None);
                    record.last_result = Some("Late reminder · Still was closed or this PC was asleep when this was due.".into());
                    self.commit(index, &record);
                    self.persist(None).await?;
                    let _ = self.present(record.clone(), occurrence, true, record.last_result.clone().unwrap_or_default(), false);
                    continue;
                }
                let prefs = app.prefs();
                let apps: Vec<TargetApp> = match record.block_mode.as_str() {
                    "none" => Vec::new(),
                    "current" => {
                        let selected: Vec<&str> = prefs["selected"].as_array().map(|s| s.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
                        prefs["apps"].as_array().map(|list| list.iter().filter(|a| a["path"].as_str().is_some_and(|p| selected.contains(&p))).filter_map(|a| serde_json::from_value(a.clone()).ok()).collect()).unwrap_or_default()
                    }
                    _ => record.apps.clone(),
                };
                record.occurrence_apps = Some(apps.clone());
                record.pending = Some((!apps.is_empty()).then(|| Pending { start: occurrence.start, end: occurrence.end, apps: apps.clone() }));
                record.last_result = Some(
                    if !apps.is_empty() { "Waiting to start blocking…" } else if record.block_mode == "current" { "Reminder delivered · no apps or websites were selected for blocking." } else { "Reminder delivered · no apps or websites blocked." }.into(),
                );
                self.commit(index, &record);
                // Claim the occurrence before showing it or sending any blocking request.
                self.persist(None).await?;
                let _ = self.present(record.clone(), occurrence, false, record.last_result.clone().unwrap_or_default(), false);
            }
            let Some(pending) = record.pending().cloned().filter(|_| record.snooze_at.unwrap_or(0) == 0) else { continue };
            if pending.end <= now_ms() {
                record.pending = Some(None);
                record.last_result = Some("Focus window ended before blocking could start.".into());
                self.commit(index, &record);
                changed = true;
                continue;
            }
            // Only reuse an active session in this pass, and never past its guard deadline.
            let stale = match &cached {
                None => true,
                Some((status, read_at, generation)) => {
                    let elapsed = now_ms() - read_at;
                    status.get("unavailable") == Some(&Value::Bool(true))
                        || status["session"]["phase"] != "active"
                        || *generation != app.guard.generation()
                        || elapsed < 0
                        || status["now"].as_i64().unwrap_or(*read_at) + elapsed >= status["session"]["endsAt"].as_i64().unwrap_or(0)
                }
            };
            if stale {
                let (read_at, generation) = (now_ms(), app.guard.generation());
                cached = Some((app.status(false).await, read_at, generation));
            }
            let current = cached.as_ref().map(|(status, _, _)| status.clone()).unwrap_or_default();
            let ringing_this = |this: &Self| this.st.borrow().active.as_ref().is_some_and(|a| a.item.alert.id == record.id);
            if !current["session"].is_null() {
                let message = "Another focus session is running. Blocking will start if time remains.";
                if record.last_result.as_deref() != Some(message) {
                    record.last_result = Some(message.into());
                    self.commit(index, &record);
                    changed = true;
                    if ringing_this(self) {
                        self.send_alarm_status(message);
                    }
                }
                continue;
            }
            let wants_websites = pending.apps.iter().any(|a| a.is_website());
            let not_ready = current["installed"] != true
                || current.get("unavailable") == Some(&Value::Bool(true))
                || (current["demo"] != true && (current["scheduledAlerts"] != true || current["snoozeAlerts"] != true || (wants_websites && current["websiteBlocking"] != true)));
            if not_ready {
                let message = "Apps are NOT blocked. Prepare / update blocking in Alerts; blocking will start if time remains.";
                if record.last_result.as_deref() != Some(message) {
                    record.last_result = Some(message.into());
                    changed = true;
                }
            } else {
                // Clear before submitting: a disconnected reply must never replay a start request.
                record.pending = Some(None);
                record.last_result = Some("Starting blocking…".into());
                self.commit(index, &record);
                self.persist(None).await?;
                let prefs = app.prefs();
                let started = async {
                    let minutes = ((pending.end - now_ms() + 59_999) / 60_000).clamp(1, 1440);
                    let mut request = domain::validate_session(&json!({ "apps": pending.apps, "blockScreen": prefs.get("blockScreen"), "intention": record.title, "durationMinutes": minutes, "unlockDelayMinutes": record.unlock_delay_minutes }))?;
                    request["scheduledEndsAt"] = json!(pending.end);
                    let result = app.start_session(request, true).await?;
                    if result["session"].is_null() || result["session"]["phase"] != "active" {
                        return Err("Protection did not report an active session.".to_string());
                    }
                    Ok(result["session"]["id"].as_str().unwrap_or_default().to_string())
                }
                .await;
                match started {
                    Ok(id) => {
                        record.session_id = Some(Some(id));
                        record.last_result = Some(format!("Started a focus session with {} apps / websites blocked.", pending.apps.len()));
                    }
                    Err(error) => record.last_result = Some(format!("Blocking could not be confirmed. Check Focus space. {error}")),
                }
                cached = None;
                changed = true;
            }
            self.commit(index, &record);
            if ringing_this(self) {
                self.send_alarm_status(record.last_result.as_deref().unwrap_or_default());
            }
        }
        if changed {
            self.persist(None).await?;
        }
        Ok(())
    }
}

fn extension(name: &str) -> Option<String> {
    Path::new(name).extension().map(|e| e.to_string_lossy().to_lowercase())
}

#[allow(dead_code)]
fn _unused(_: &Value) -> Option<&str> {
    str_of(prop(&Value::Null, ""))
}
