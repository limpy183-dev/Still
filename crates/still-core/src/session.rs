//! Port of `native/Session.cs` and the request/state types of `native/Guard.cs`.
//! Field names are the JSON names the guard, the app and `state.json` already use.
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::sync::LazyLock;

use crate::websites;

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct TargetApp {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub path: Option<String>,
}

impl TargetApp {
    pub fn path(&self) -> &str {
        self.path.as_deref().unwrap_or("")
    }
    pub fn is_website(&self) -> bool {
        self.path().starts_with("website:")
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct BlockScreen {
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub image: Option<String>,
    #[serde(default)]
    pub redirect: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FocusSession {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub archived: bool,
    #[serde(default)]
    pub intention: Option<String>,
    #[serde(default)]
    pub started_at: i64,
    #[serde(default)]
    pub ends_at: i64,
    #[serde(default)]
    pub scheduled_ends_at: i64,
    #[serde(default)]
    pub duration_minutes: i64,
    #[serde(default)]
    pub unlock_delay_minutes: i64,
    #[serde(default)]
    pub unlock_at: i64,
    #[serde(default)]
    pub apps: Vec<TargetApp>,
    #[serde(default)]
    pub block_screen: Option<BlockScreen>,
    #[serde(default)]
    pub phase: Option<String>,
    #[serde(default)]
    pub outcome: Option<String>,
    #[serde(default)]
    pub finished_at: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct GuardState {
    #[serde(default)]
    pub session: Option<FocusSession>,
    #[serde(default)]
    pub history: Vec<FocusSession>,
    #[serde(default)]
    pub error: Option<String>,
}

static APPX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^appx:[a-zA-Z0-9.\-_]+_[a-zA-Z0-9]+$").unwrap());

pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

impl FocusSession {
    /// Without a scheduled end the session lasts `minutes`; a scheduled end must be in the future and at most 25 hours away.
    pub fn resolve_end(minutes: i64, scheduled_ends_at: i64, now: i64) -> Result<i64, String> {
        if scheduled_ends_at == 0 {
            return Ok(now + minutes * 60000);
        }
        // A local time range can span 25 hours when daylight saving time ends.
        if scheduled_ends_at <= now || scheduled_ends_at > now + 1500 * 60000 {
            return Err("The scheduled focus window has ended or is too long.".into());
        }
        Ok(scheduled_ends_at)
    }
    pub fn expired(&self, now: i64) -> bool {
        now >= self.ends_at
    }
    pub fn can_end(&self, now: i64) -> bool {
        self.unlock_delay_minutes == 0 || (self.unlock_at > 0 && now >= self.unlock_at)
    }
    pub fn request_unlock(&mut self, now: i64) {
        if self.unlock_at == 0 {
            self.unlock_at = now + self.unlock_delay_minutes * 60000;
        }
    }
    /// The live view sent on every status poll: the session without its (large) block-screen artwork.
    pub fn summary(&self) -> FocusSession {
        FocusSession { block_screen: None, ..self.clone() }
    }
}

/// Native-side bounds check for a start request (the app validates first, the guard again).
pub fn validate_start(minutes: i64, delay: i64, apps: &[TargetApp]) -> Result<(), String> {
    if !(1..=1440).contains(&minutes) {
        return Err("Choose a focus duration from 1 to 1,440 minutes.".into());
    }
    if !(0..=120).contains(&delay) {
        return Err("Choose a release delay from 0 to 120 minutes.".into());
    }
    if apps.is_empty() || apps.len() > 100 {
        return Err("Select between 1 and 100 apps or websites.".into());
    }
    for app in apps {
        if app.is_website() {
            websites::domain_of(app)?;
            continue;
        }
        let path = app.path();
        if APPX.is_match(path) {
            continue;
        }
        let rooted = path.starts_with(['\\', '/']) || path.as_bytes().get(1) == Some(&b':') && matches!(path.as_bytes().get(2), Some(b'\\' | b'/'));
        if path.trim().is_empty() || !rooted || !path.to_lowercase().ends_with(".exe") || path.contains(['*', '?', '\r', '\n']) {
            return Err("Select a full path to a Windows .exe file.".into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_delay_is_measured_from_the_request_and_cannot_be_reset() {
        let mut s = FocusSession { ends_at: 1_000_000, unlock_delay_minutes: 5, ..Default::default() };
        assert!(!s.can_end(1000), "Locked before release request");
        s.request_unlock(1000);
        assert_eq!(s.unlock_at, 301_000);
        s.request_unlock(2000);
        assert_eq!(s.unlock_at, 301_000, "Repeated requests cannot reset the waiting period");
        assert!(!s.can_end(300_999));
        assert!(s.can_end(301_000));
        s.unlock_at = 0;
        assert!(!s.can_end(400_000), "Cancellation restores lock");
        assert!(s.expired(1_000_000) && !s.expired(999_999));
        s.unlock_delay_minutes = 0;
        assert!(s.can_end(1));
    }

    #[test]
    fn deadlines_resolve_like_the_original() {
        assert_eq!(FocusSession::resolve_end(50, 0, 1000), Ok(3_001_000));
        assert_eq!(FocusSession::resolve_end(50, 50_000, 1000), Ok(50_000));
        assert!(FocusSession::resolve_end(50, 1000, 1000).is_err());
        assert!(FocusSession::resolve_end(50, 1000 + 1501 * 60000, 1000).is_err());
    }

    #[test]
    fn start_requests_are_bounded() {
        let apps = vec![TargetApp { name: None, path: Some("C:\\Games\\game.exe".into()) }];
        assert!(validate_start(25, 5, &apps).is_ok());
        for minutes in [0, -1, 1441] {
            assert!(validate_start(minutes, 0, &apps).is_err());
        }
        assert!(validate_start(25, 121, &apps).is_err());
        assert!(validate_start(25, 5, &[]).is_err());
        assert!(validate_start(25, 5, &[TargetApp { name: None, path: Some("game.exe".into()) }]).is_err());
        assert!(validate_start(25, 5, &[TargetApp { name: None, path: Some("website:youtube.com".into()) }]).is_ok());
    }

    #[test]
    fn restart_preserves_the_release_deadline() {
        let mut s = FocusSession { unlock_delay_minutes: 5, ..Default::default() };
        s.request_unlock(700);
        let restored: FocusSession = serde_json::from_str(&serde_json::to_string(&s).unwrap()).unwrap();
        assert_eq!(restored.unlock_at, s.unlock_at);
        assert!(!restored.can_end(1000));
    }

    #[test]
    fn state_written_by_the_original_guard_still_loads() {
        let json = r#"{"session":null,"history":[{"id":"a","archived":false,"intention":"Write","startedAt":1,"endsAt":2,"scheduledEndsAt":0,"durationMinutes":1,"unlockDelayMinutes":0,"unlockAt":0,"apps":[{"name":"Game","path":"C:\\g.exe"}],"blockScreen":null,"phase":"releasing","outcome":"completed","finishedAt":3}],"error":null}"#;
        let state: GuardState = serde_json::from_str(json).unwrap();
        assert_eq!(state.history[0].outcome.as_deref(), Some("completed"));
        assert_eq!(state.history[0].apps[0].path(), "C:\\g.exe");
    }
}
