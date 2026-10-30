//! The guard's session state machine and request protocol (the logic of `native/Guard.cs`).
//! Everything that touches Windows (AppLocker policy, browser policy, file checks) sits behind [`Enforcer`],
//! so the rules here are tested without a service, administrator rights or policy changes.
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    sync::{
        Condvar, Mutex, MutexGuard, TryLockError,
        atomic::{AtomicBool, AtomicI64, Ordering},
    },
    time::{Duration, Instant},
};
use still_core::{
    js::slice16,
    session::{BlockScreen, FocusSession, GuardState, TargetApp, now_ms, validate_start},
    websites,
};

pub const SERVICE_NAME: &str = "StillFocusGuard";
pub const PIPE_NAME: &str = r"\\.\pipe\Still.Focus.Guard.v1";

/// A request from the app (or the browser host), as the JSON line it sends.
#[derive(Deserialize, Default, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Request {
    pub block_screen: Option<BlockScreen>,
    pub command: Option<String>,
    pub history_revision: Option<String>,
    pub id: Option<String>,
    pub action: Option<String>,
    pub duration_minutes: i64,
    pub scheduled_ends_at: i64,
    pub unlock_delay_minutes: i64,
    pub intention: Option<String>,
    pub apps: Option<Vec<TargetApp>>,
}

/// What the guard changes on the PC. The real one runs the AppLocker script and writes browser policy.
pub trait Enforcer: Send + Sync {
    /// Puts the blocks for `apps` in place (browser policy for websites, AppLocker rules for apps).
    fn apply(&self, apps: &[TargetApp], owner: &str) -> Result<(), String>;
    /// Releases every block Still holds. Safe to repeat.
    fn clear(&self) -> Result<(), String>;
    /// Checks a desktop app target (existence, protected components) and normalises its path and name.
    fn validate_target(&self, app: &mut TargetApp) -> Result<(), String>;
}

#[derive(Clone)]
pub struct Paths {
    pub data: PathBuf,
    pub state: PathBuf,
}

impl Paths {
    pub fn new(data: PathBuf) -> Paths {
        Paths { state: data.join("state.json"), data }
    }
}

/// A clock that never goes backwards, even if the system clock is set back during a session.
struct Clock {
    origin: i64,
    start: Instant,
    last: AtomicI64,
}

impl Clock {
    fn now(&self) -> i64 {
        let candidate = now_ms().max(self.origin + self.start.elapsed().as_millis() as i64);
        self.last.fetch_max(candidate, Ordering::SeqCst).max(candidate)
    }
}

struct Inner {
    state: GuardState,
    history_revision: String,
    recovery_pending: bool,
    next_recovery_at: i64,
}

pub struct Guard {
    pub paths: Paths,
    owner: String,
    enforcer: Box<dyn Enforcer>,
    gate: Mutex<Inner>,
    website_await: Mutex<Option<String>>,
    website_ready: (Mutex<bool>, Condvar),
    clock: Clock,
    pub stopping: AtomicBool,
    /// Set once the saved state is loaded and leftovers are released; the pipe opens only after that.
    pub ready: AtomicBool,
}

fn guid() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// Atomic, durable write: a temp file is flushed, then swapped in (keeping the previous file as `.bak`).
pub fn atomic_write(file: &Path, text: &str) -> std::io::Result<()> {
    use std::io::Write;
    let temp = PathBuf::from(format!("{}.tmp", file.display()));
    {
        let mut stream = std::fs::File::create(&temp)?;
        stream.write_all(text.as_bytes())?;
        stream.sync_all()?;
    }
    if file.exists() { crate::enforce::replace_file(file, &temp) } else { std::fs::rename(&temp, file) }
}

fn trim_history(state: &mut GuardState) {
    state.history.truncate(500);
    while state.history.len() > 1 && serde_json::to_string(state).map_or(0, |s| s.len()) > 700_000 {
        state.history.pop();
    }
}

impl Guard {
    pub fn new(paths: Paths, owner: String, enforcer: Box<dyn Enforcer>) -> Guard {
        Guard {
            paths,
            owner,
            enforcer,
            gate: Mutex::new(Inner { state: GuardState::default(), history_revision: guid(), recovery_pending: false, next_recovery_at: 0 }),
            website_await: Mutex::new(None),
            website_ready: (Mutex::new(false), Condvar::new()),
            clock: Clock { origin: now_ms(), start: Instant::now(), last: AtomicI64::new(0) },
            stopping: AtomicBool::new(false),
            ready: AtomicBool::new(false),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.gate.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn now(&self) -> i64 {
        self.clock.now()
    }

    fn save(&self, inner: &Inner) -> std::io::Result<()> {
        atomic_write(&self.paths.state, &serde_json::to_string(&inner.state).map_err(std::io::Error::other)?)
    }

    fn clear_protection(&self) -> Result<(), String> {
        self.enforcer.clear()
    }

    fn reset_website_wait(&self, id: Option<String>) {
        *self.website_await.lock().unwrap() = id;
        *self.website_ready.0.lock().unwrap() = false;
    }

    /// Called by the browser host when a connected browser has applied the website blocks.
    pub fn website_ready(&self, id: Option<&str>) -> bool {
        let accepted = id.is_some() && *self.website_await.lock().unwrap() == id.map(String::from);
        if accepted {
            *self.website_ready.0.lock().unwrap() = true;
            self.website_ready.1.notify_all();
        }
        accepted
    }

    fn wait_for_websites(&self, limit: Duration) -> bool {
        let (flag, signal) = &self.website_ready;
        let guard = flag.lock().unwrap();
        *signal.wait_timeout_while(guard, limit, |ready| !*ready).unwrap().0
    }

    /// Loads the saved state and releases anything a previous run left behind (the service's start-up work).
    pub fn init(&self) {
        let mut inner = self.lock();
        let loaded = (|| -> Result<GuardState, String> {
            if !self.paths.state.exists() {
                return Ok(GuardState::default());
            }
            let text = std::fs::read_to_string(&self.paths.state).map_err(|e| e.to_string())?;
            let mut state: GuardState = serde_json::from_str(&text).map_err(|e| e.to_string())?;
            trim_history(&mut state);
            Ok(state)
        })();
        match loaded {
            Ok(state) => inner.state = state,
            Err(_) => {
                inner.state = GuardState { error: Some("Session data could not be read.".into()), ..Default::default() };
                let released = self.clear_protection().and_then(|()| {
                    inner.state.error.as_mut().map(|e| e.push_str(" Orphaned focus rules have been released."));
                    self.save(&inner).map_err(|e| e.to_string())
                });
                if let Err(error) = released {
                    inner.state.error.as_mut().map(|e| e.push_str(&format!(" Recovery needs attention: {error}")));
                }
            }
        }
        let startup = (|| -> Result<(), String> {
            let phase = inner.state.session.as_ref().map(|s| s.phase.clone().unwrap_or_default());
            match phase {
                None => self.clear_protection()?,
                Some(phase) if phase != "active" => self.finish(&mut inner, "interrupted")?,
                Some(_) if inner.state.session.as_ref().is_some_and(|s| s.expired(self.now())) => self.finish(&mut inner, "completed")?,
                Some(_) => {}
            }
            // Publish an authoritative initial snapshot to connected browsers.
            self.save(&inner).map_err(|e| e.to_string())
        })();
        if let Err(error) = startup {
            inner.state.error = Some(error);
            inner.recovery_pending = inner.state.session.is_none();
            inner.next_recovery_at = self.now() + 30_000;
        }
        self.ready.store(true, Ordering::SeqCst);
    }

    /// Once a second: retries a failed release, honours a recovery request and ends sessions that are over.
    pub fn tick(&self) {
        let mut inner = match self.gate.try_lock() {
            Ok(inner) => inner,
            Err(TryLockError::Poisoned(p)) => p.into_inner(),
            Err(TryLockError::WouldBlock) => return,
        };
        let outcome = (|| -> Result<(), String> {
            if inner.recovery_pending && inner.state.session.is_none() && self.now() >= inner.next_recovery_at {
                inner.next_recovery_at = self.now() + 30_000;
                self.clear_protection()?;
                inner.state.error = None;
                self.save(&inner).map_err(|e| e.to_string())?;
                inner.recovery_pending = false;
            }
            let request = self.paths.data.join("recover-request");
            if request.exists() {
                if inner.state.session.is_some() { self.finish(&mut inner, "recovered")? } else { self.clear_protection()? }
                let _ = std::fs::remove_file(&request);
            }
            let due = inner.state.session.as_ref().filter(|s| s.expired(self.now()) || s.phase.as_deref() == Some("releasing")).map(|s| (s.phase.clone(), s.outcome.clone()));
            if let Some((phase, outcome)) = due {
                let outcome = if phase.as_deref() == Some("releasing") { outcome.unwrap_or_default() } else { "completed".into() };
                self.finish(&mut inner, &outcome)?;
            }
            Ok(())
        })();
        if let Err(error) = outcome {
            inner.state.error = Some(format!("Release needs attention: {error}"));
        }
    }

    fn finish(&self, inner: &mut Inner, outcome: &str) -> Result<(), String> {
        {
            let session = inner.state.session.as_mut().ok_or("No active session.")?;
            session.phase = Some("releasing".into());
            session.outcome = Some(outcome.into());
        }
        // A full disk must not prevent an attempt to release expired rules.
        let _ = self.save(inner);
        self.clear_protection()?;
        let mut session = inner.state.session.take().ok_or("No active session.")?;
        session.finished_at = self.now();
        session.block_screen = None; // Artwork belongs to the active session, not every history record.
        inner.state.history.insert(0, session);
        inner.history_revision = guid();
        inner.state.error = None;
        trim_history(&mut inner.state);
        let saved = self.save(inner).map_err(|e| e.to_string());
        self.reset_website_wait(None);
        saved
    }

    /// The reply to a request: the status snapshot, or the error that stopped it.
    pub fn handle_request(&self, request: &Request) -> Value {
        let mut inner = self.lock();
        match self.handle(&mut inner, request) {
            Ok(()) => self.status_response(&inner, request),
            Err(error) => json!({ "ok": false, "error": error }),
        }
    }

    fn status_response(&self, inner: &Inner, request: &Request) -> Value {
        let state = &inner.state;
        let mut response = json!({
            "ok": true, "installed": true, "scheduledAlerts": true, "snoozeAlerts": true, "websiteBlocking": true, "websiteLimits": true,
            "session": state.session.as_ref().map(FocusSession::summary), "historyRevision": inner.history_revision,
            "error": state.error, "now": self.now(),
        });
        // A new process has a fresh token, so reconnects cannot reuse stale history.
        if request.command.as_deref() != Some("status") || request.history_revision.as_deref() != Some(inner.history_revision.as_str()) {
            response["history"] = json!(state.history);
        }
        response
    }

    fn handle(&self, inner: &mut Inner, request: &Request) -> Result<(), String> {
        if inner.state.session.as_ref().is_some_and(|s| s.expired(self.now())) {
            self.finish(inner, "completed")?;
        }
        let require_session = |inner: &Inner| match inner.state.session.as_ref() {
            Some(s) if s.phase.as_deref() == Some("active") => Ok(()),
            _ => Err("No active session.".to_string()),
        };
        match request.command.as_deref().unwrap_or_default() {
            "status" => Ok(()),
            "updateHistory" => {
                let action = request.action.as_deref().unwrap_or_default();
                if !["archive", "restore", "delete"].contains(&action) {
                    return Err("Invalid history action.".into());
                }
                let index = inner.state.history.iter().position(|s| Some(s.id.as_str()) == request.id.as_deref()).ok_or("Saved session not found.")?;
                let previous = inner.state.history.clone();
                if action == "delete" {
                    inner.state.history.remove(index);
                } else {
                    inner.state.history[index].archived = action == "archive";
                }
                if let Err(error) = self.save(inner) {
                    inner.state.history = previous;
                    return Err(error.to_string());
                }
                inner.history_revision = guid();
                Ok(())
            }
            "start" => self.start(inner, request),
            "requestUnlock" => {
                require_session(inner)?;
                let now = self.now();
                inner.state.session.as_mut().map(|s| s.request_unlock(now));
                self.save(inner).map_err(|e| e.to_string())
            }
            "cancelUnlock" => {
                require_session(inner)?;
                inner.state.session.as_mut().map(|s| s.unlock_at = 0);
                self.save(inner).map_err(|e| e.to_string())
            }
            "end" => {
                require_session(inner)?;
                if !inner.state.session.as_ref().is_some_and(|s| s.can_end(self.now())) {
                    return Err("The release waiting period has not finished yet.".into());
                }
                self.finish(inner, "ended-early")
            }
            "snooze" => {
                let Some(session) = inner.state.session.as_ref().filter(|s| Some(s.id.as_str()) == request.id.as_deref()) else { return Ok(()) };
                if session.scheduled_ends_at == 0 {
                    return Err("Only an alarm session can be snoozed.".into());
                }
                self.finish(inner, "snoozed")
            }
            _ => Err("Unknown command.".into()),
        }
    }

    fn start(&self, inner: &mut Inner, request: &Request) -> Result<(), String> {
        if inner.state.session.is_some() {
            return Err("A focus session is already running.".into());
        }
        let requested = request.apps.clone().unwrap_or_default();
        validate_start(request.duration_minutes, request.unlock_delay_minutes, &requested)?;
        let mut seen = std::collections::HashSet::new();
        let mut apps: Vec<TargetApp> = requested.into_iter().filter(|a| seen.insert(a.path().to_lowercase())).collect();
        for app in apps.iter_mut().filter(|a| !a.is_website()) {
            self.enforcer.validate_target(app)?;
        }
        let targets: Vec<Value> = apps.iter().map(|a| json!({ "name": a.name, "path": a.path })).collect();
        let screen = websites_screen(request.block_screen.as_ref(), &targets)?;
        let now = self.now();
        let intention = slice16(request.intention.as_deref().unwrap_or("Time to focus"), 120);
        let has_websites = apps.iter().any(TargetApp::is_website);
        let session = FocusSession {
            id: guid(),
            intention: Some(intention),
            duration_minutes: request.duration_minutes,
            unlock_delay_minutes: request.unlock_delay_minutes,
            scheduled_ends_at: request.scheduled_ends_at,
            apps: apps.clone(),
            block_screen: Some(screen),
            started_at: now,
            ends_at: FocusSession::resolve_end(request.duration_minutes, request.scheduled_ends_at, now)?,
            phase: Some("applying".into()),
            ..Default::default()
        };
        let session_id = session.id.clone();
        inner.state.session = Some(session);
        inner.state.error = None;
        self.reset_website_wait(has_websites.then(|| session_id));
        if let Err(error) = self.save(inner) {
            inner.state.session = None;
            return Err(error.to_string());
        }
        let started = (|| -> Result<(), String> {
            self.enforcer.apply(&apps, &self.owner)?;
            if has_websites && !self.wait_for_websites(Duration::from_secs(15)) {
                return Err("Open Chrome or Edge with the Still companion connected and incognito / InPrivate access enabled before starting website blocking. Set it up in Settings.".into());
            }
            let now = self.now();
            let session = inner.state.session.as_mut().ok_or("No active session.")?;
            session.started_at = now;
            session.ends_at = FocusSession::resolve_end(request.duration_minutes, request.scheduled_ends_at, now)?;
            session.phase = Some("active".into());
            self.save(inner).map_err(|e| e.to_string())
        })();
        if let Err(start_error) = started {
            if let Err(release_error) = self.finish(inner, "failed") {
                inner.state.error = Some(release_error);
                let _ = self.save(inner);
            }
            return Err(format!("Could not start protection: {start_error}"));
        }
        Ok(())
    }
}

/// The guard's own check of a block screen against the selected websites.
fn websites_screen(screen: Option<&BlockScreen>, targets: &[Value]) -> Result<BlockScreen, String> {
    let value = screen.map(|s| serde_json::to_value(s).unwrap_or_default()).unwrap_or_else(|| json!({ "mode": "garden" }));
    let mode = value["mode"].as_str().unwrap_or("garden");
    if !["garden", "dusk", "paper", "custom", "redirect"].contains(&mode) {
        return Err("Choose a website block screen.".into());
    }
    let (title, text, image) = (value["title"].as_str().unwrap_or(""), value["text"].as_str().unwrap_or(""), value["image"].as_str().unwrap_or(""));
    if title.encode_utf16().count() > 120 || text.encode_utf16().count() > 1000 || image.encode_utf16().count() > 180_000 {
        return Err("The block screen is too large.".into());
    }
    if !image.is_empty() && !websites::is_data_image(image) {
        return Err("Invalid block-screen image.".into());
    }
    let mut result: BlockScreen = serde_json::from_value(value.clone()).map_err(|e| e.to_string())?;
    if mode != "custom" {
        result.image = None;
    }
    for target in targets.iter().filter(|t| websites::is_website(t)) {
        websites::domain_of(&serde_json::from_value(target.clone()).unwrap_or_default())?;
    }
    if mode == "redirect" {
        let redirect = value["redirect"].as_str().unwrap_or("");
        let url = url::Url::parse(redirect).ok().filter(|u| u.scheme() == "https" && u.username().is_empty() && u.password().is_none() && redirect.encode_utf16().count() <= 2048).ok_or("Choose a valid HTTPS redirect.")?;
        let host = url.host_str().unwrap_or("").to_lowercase();
        let host = host.trim_end_matches('.');
        let host = host.strip_prefix("www.").unwrap_or(host);
        websites::domain_of(&TargetApp { name: None, path: Some(format!("website:{host}")) })?;
        let blocked = targets.iter().filter(|t| websites::is_website(t)).filter_map(|t| t["path"].as_str()).map(|p| &p[8..]).any(|d| host == d || host.ends_with(&format!(".{d}")));
        if blocked {
            return Err("The redirect destination is blocked.".into());
        }
    }
    Ok(result)
}

/// Reads one request line (at most 256 KB, each read within 5 s). `None` means a bad or unfinished request.
pub async fn read_request<R: tokio::io::AsyncRead + Unpin>(stream: &mut R) -> Option<String> {
    use tokio::io::AsyncReadExt;
    const LIMIT: usize = 262_144;
    let mut data: Vec<u8> = Vec::new();
    let mut chunk = vec![0u8; 8192];
    while data.len() < LIMIT {
        let read = tokio::time::timeout(Duration::from_secs(5), stream.read(&mut chunk)).await.ok()?.ok()?;
        if read == 0 {
            return None;
        }
        let start = data.len();
        data.extend_from_slice(&chunk[..read]);
        if let Some(end) = data[start..].iter().position(|b| *b == b'\n') {
            let line = &data[..start + end];
            return (line.len() < LIMIT).then(|| String::from_utf8_lossy(line).into_owned());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    struct Fake {
        applied: Mutex<Vec<String>>,
        cleared: Mutex<u32>,
        fail_apply: AtomicBool,
    }
    impl Enforcer for Arc<Fake> {
        fn apply(&self, apps: &[TargetApp], _owner: &str) -> Result<(), String> {
            if self.fail_apply.load(Ordering::SeqCst) {
                return Err("policy refused".into());
            }
            self.applied.lock().unwrap().extend(apps.iter().map(|a| a.path().to_string()));
            Ok(())
        }
        fn clear(&self) -> Result<(), String> {
            *self.cleared.lock().unwrap() += 1;
            Ok(())
        }
        fn validate_target(&self, _app: &mut TargetApp) -> Result<(), String> {
            Ok(())
        }
    }

    fn guard() -> (Guard, Arc<Fake>, PathBuf) {
        let dir = std::env::temp_dir().join(format!("Still-protocol-{}", guid()));
        std::fs::create_dir_all(&dir).unwrap();
        let fake = Arc::new(Fake { applied: Mutex::default(), cleared: Mutex::default(), fail_apply: AtomicBool::new(false) });
        (Guard::new(Paths::new(dir.clone()), "S-1-5-21-1".into(), Box::new(fake.clone())), fake, dir)
    }
    fn request(command: &str) -> Request {
        Request { command: Some(command.into()), ..Default::default() }
    }
    fn start(minutes: i64, delay: i64, apps: &[&str]) -> Request {
        Request { command: Some("start".into()), duration_minutes: minutes, unlock_delay_minutes: delay, apps: Some(apps.iter().map(|p| TargetApp { name: Some("App".into()), path: Some(p.to_string()) }).collect()), ..Default::default() }
    }

    #[test]
    fn history_revisions_and_status_snapshots() {
        let (g, _, dir) = guard();
        g.lock().state.history.push(FocusSession { id: "record".into(), ..Default::default() });
        let full = g.handle_request(&request("status"));
        assert_eq!(full["snoozeAlerts"], true, "Advertises alarm snooze support");
        assert!(full.get("history").is_some(), "Legacy request has full history");
        let token = full["historyRevision"].as_str().unwrap().to_string();
        let compact = g.handle_request(&Request { history_revision: Some(token.clone()), ..request("status") });
        assert!(compact.get("history").is_none() && compact.get("now").is_some() && compact.get("session").is_some(), "Compact status retains live fields");
        assert!(g.handle_request(&Request { history_revision: Some(token.clone()), ..request("snooze") }).get("history").is_some(), "Mutation response remains a snapshot");
        let mut token = token;
        for action in ["archive", "restore", "delete"] {
            g.handle_request(&Request { id: Some("record".into()), action: Some(action.into()), ..request("updateHistory") });
            let updated = g.handle_request(&Request { history_revision: Some(token.clone()), ..request("status") });
            assert!(updated.get("history").is_some() && updated["historyRevision"] != token.as_str(), "{action} changes revision");
            token = updated["historyRevision"].as_str().unwrap().to_string();
        }
        let (restarted, _, _) = guard();
        assert_ne!(restarted.handle_request(&request("status"))["historyRevision"], token.as_str(), "Restart changes token");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn snooze_cannot_bypass_a_manual_session_delay() {
        let (g, _, dir) = guard();
        g.lock().state.session = Some(FocusSession { id: "manual".into(), phase: Some("active".into()), unlock_delay_minutes: 30, ends_at: now_ms() + 600_000, ..Default::default() });
        g.handle_request(&Request { id: Some("other".into()), ..request("snooze") });
        assert_eq!(g.lock().state.session.as_ref().unwrap().id, "manual", "Snooze leaves unrelated sessions alone");
        let reply = g.handle_request(&Request { id: Some("manual".into()), ..request("snooze") });
        assert!(reply["error"].as_str().unwrap().contains("Only an alarm"));
        assert!(g.lock().state.session.is_some());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_session_runs_locks_and_releases() {
        let (g, fake, dir) = guard();
        let started = g.handle_request(&start(25, 5, &["C:\\Games\\game.exe"]));
        assert_eq!(started["ok"], true, "{started}");
        assert_eq!(started["session"]["phase"], "active");
        assert_eq!(fake.applied.lock().unwrap().as_slice(), ["C:\\Games\\game.exe"]);
        assert!(g.handle_request(&start(25, 5, &["C:\\Games\\other.exe"]))["error"].as_str().unwrap().contains("already running"));
        assert!(g.handle_request(&request("end"))["error"].as_str().unwrap().contains("waiting period"));
        g.handle_request(&request("requestUnlock"));
        let unlock = g.lock().state.session.as_ref().unwrap().unlock_at;
        assert!(unlock > 0);
        g.handle_request(&request("requestUnlock"));
        assert_eq!(g.lock().state.session.as_ref().unwrap().unlock_at, unlock, "A second request cannot reset the wait");
        g.handle_request(&request("cancelUnlock"));
        assert_eq!(g.lock().state.session.as_ref().unwrap().unlock_at, 0);
        {
            let mut inner = g.lock();
            inner.state.session.as_mut().unwrap().unlock_delay_minutes = 0;
        }
        let ended = g.handle_request(&request("end"));
        assert!(ended["session"].is_null() && ended["history"][0]["outcome"] == "ended-early", "{ended}");
        assert!(ended["history"][0]["blockScreen"].is_null(), "History keeps no artwork");
        assert!(*fake.cleared.lock().unwrap() >= 1);
        let saved: GuardState = serde_json::from_str(&std::fs::read_to_string(g.paths.state.clone()).unwrap()).unwrap();
        assert_eq!(saved.history.len(), 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_failed_start_releases_everything_and_says_why() {
        let (g, fake, dir) = guard();
        fake.fail_apply.store(true, Ordering::SeqCst);
        let reply = g.handle_request(&start(25, 0, &["C:\\Games\\game.exe"]));
        assert_eq!(reply["error"], "Could not start protection: policy refused");
        let status = g.handle_request(&request("status"));
        assert!(status["session"].is_null() && status["history"][0]["outcome"] == "failed");
        assert!(*fake.cleared.lock().unwrap() >= 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn website_sessions_wait_for_the_browser_and_time_out() {
        let (g, _, dir) = guard();
        let g = Arc::new(g);
        let site = "website:youtube.com";
        let helper = {
            let g = g.clone();
            std::thread::spawn(move || {
                for _ in 0..100 {
                    // The handler holds the gate while it waits, so the id comes from the await slot, never the gate.
                    let waiting = g.website_await.lock().unwrap().clone();
                    if let Some(id) = waiting {
                        if g.website_ready(Some(&id)) {
                            return true;
                        }
                    }
                    std::thread::sleep(Duration::from_millis(20));
                }
                false
            })
        };
        let reply = g.handle_request(&start(25, 0, &[site]));
        assert_eq!(reply["ok"], true, "{reply}");
        assert!(helper.join().unwrap());
        assert!(!g.website_ready(Some("some-other-id")), "Only the current session id is accepted");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn invalid_requests_are_rejected() {
        let (g, _, dir) = guard();
        for bad in [start(0, 0, &["C:\\a.exe"]), start(1441, 0, &["C:\\a.exe"]), start(25, 121, &["C:\\a.exe"]), start(25, 0, &[]), start(25, 0, &["relative.exe"]), start(25, 0, &["website:localhost"])] {
            assert_eq!(g.handle_request(&bad)["ok"], false);
        }
        assert_eq!(g.handle_request(&request("nonsense"))["error"], "Unknown command.");
        assert_eq!(g.handle_request(&request("end"))["error"], "No active session.");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn expired_sessions_complete_on_the_next_tick() {
        let (g, _, dir) = guard();
        g.handle_request(&start(1, 0, &["C:\\Games\\game.exe"]));
        g.lock().state.session.as_mut().unwrap().ends_at = now_ms() - 1;
        g.tick();
        assert!(g.lock().state.session.is_none());
        assert_eq!(g.lock().state.history[0].outcome.as_deref(), Some("completed"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn startup_releases_a_session_that_was_interrupted() {
        let (g, fake, dir) = guard();
        let interrupted = FocusSession { id: "x".into(), phase: Some("applying".into()), ends_at: now_ms() + 100_000, ..Default::default() };
        std::fs::write(&g.paths.state, serde_json::to_string(&GuardState { session: Some(interrupted), ..Default::default() }).unwrap()).unwrap();
        g.init();
        assert!(g.lock().state.session.is_none());
        assert_eq!(g.lock().state.history[0].outcome.as_deref(), Some("interrupted"));
        assert!(*fake.cleared.lock().unwrap() >= 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn an_unreadable_state_file_is_replaced_and_reported() {
        let (g, _, dir) = guard();
        std::fs::write(&g.paths.state, "not json").unwrap();
        g.init();
        let error = g.lock().state.error.clone().unwrap();
        assert!(error.starts_with("Session data could not be read.") && error.contains("Orphaned focus rules have been released."), "{error}");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn request_lines_are_bounded() {
        for length in [20usize, 1023, 1024, 32768, 65535] {
            let input = "x".repeat(length);
            let mut stream = std::io::Cursor::new(format!("{input}\nignored").into_bytes());
            assert_eq!(read_request(&mut stream).await.as_deref(), Some(input.as_str()), "Bounded request {length}");
        }
        for input in ["partial".to_string(), format!("{}\n", "x".repeat(262_144))] {
            assert_eq!(read_request(&mut std::io::Cursor::new(input.into_bytes())).await, None, "Reject unterminated/oversized request");
        }
    }
}
