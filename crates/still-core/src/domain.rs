//! Port of `app/domain.cjs`: what Still may block, and what a session or preferences file may contain.
use crate::js::*;
use crate::websites;
use regex::Regex;
use serde_json::{Map, Value, json};
use std::sync::LazyLock;
use url::Url;

pub const PROTECTED_NAMES: [&str; 26] = [
    "still", "still.guard", "electron", "powershell", "pwsh", "cmd", "conhost", "explorer", "taskmgr", "regedit", "sc", "services", "mmc",
    "winlogon", "csrss", "lsass", "svchost", "wininit", "dwm", "sihost", "userinit", "smss", "consent", "runtimebroker", "dllhost", "rundll32",
];
const RELEASES: &str = "https://github.com/limpy183-dev/Still/releases/";

static APPX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^appx:[a-z0-9._-]+_[a-z0-9]+$").unwrap());
static PROTECTED_PACKAGE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)Microsoft\.(WindowsStore|DesktopAppInstaller|SecHealthUI|WindowsTerminal)|OpenAI\.Codex").unwrap());
static WINDOWS_DIR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\\Windows(?:Apps)?\\").unwrap());
static EXE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\.exe$").unwrap());
static VERSION: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^v?([0-9]+)\.([0-9]+)\.([0-9]+)$").unwrap());

/// Node's `path.win32.isAbsolute`.
pub fn win32_is_absolute(p: &str) -> bool {
    let c: Vec<char> = p.chars().take(3).collect();
    match c.as_slice() {
        [] => false,
        [first, ..] if matches!(first, '\\' | '/') => true,
        [d, ':', s] => d.is_ascii_alphabetic() && matches!(s, '\\' | '/'),
        _ => false,
    }
}

/// Node's `path.win32.parse(p).name`.
pub fn win32_name(p: &str) -> String {
    let trimmed = p.trim_end_matches(['\\', '/']);
    let base = trimmed.rsplit(['\\', '/']).next().unwrap_or("");
    match base.rfind('.') {
        Some(i) if i > 0 && base != ".." => base[..i].to_string(),
        _ => base.to_string(),
    }
}

/// A desktop executable or Store package that Still may block.
pub fn allowed_app(app: &Value) -> bool {
    let (Some(path), Some(_name)) = (str_of(prop(app, "path")), str_of(prop(app, "name"))) else { return false };
    if path.starts_with("appx:") {
        return APPX.is_match(path) && !PROTECTED_PACKAGE.is_match(path);
    }
    let file = win32_name(path).to_lowercase();
    win32_is_absolute(path)
        && EXE.is_match(path)
        && !path.contains(['\r', '\n', '*', '?'])
        && !PROTECTED_NAMES.contains(&file.as_str())
        && !file.starts_with("still-")
        && !WINDOWS_DIR.is_match(path)
}

pub fn allowed_target(target: &Value) -> bool {
    allowed_app(target) || websites::allowed_website(target)
}

fn list<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    match prop(value, key) {
        Some(Value::Array(a)) => a,
        _ => &[],
    }
}

fn name_path(a: &Value) -> Value {
    json!({ "name": slice16(str_of(prop(a, "name")).unwrap_or_default(), 100), "path": prop(a, "path").cloned().unwrap_or(Value::Null) })
}

/// Validates a start-session request at the IPC boundary.
pub fn validate_session(request: &Value) -> R<Value> {
    let Some(duration) = integer(prop(request, "durationMinutes")).filter(|d| (1..=1440).contains(d)) else {
        return err("Choose a duration from 1 to 1,440 minutes.");
    };
    let Some(delay) = integer(prop(request, "unlockDelayMinutes")).filter(|d| (0..=120).contains(d)) else {
        return err("Choose a release delay from 0 to 120 minutes.");
    };
    let apps = list(request, "apps");
    if !matches!(prop(request, "apps"), Some(Value::Array(_))) || apps.is_empty() || apps.len() > 100 || !apps.iter().all(allowed_target) {
        return err("Select between 1 and 100 apps or websites. Windows components cannot be blocked.");
    }
    let mut out = Map::new();
    if apps.iter().any(websites::is_website) {
        let mut screen = websites::screen(prop(request, "blockScreen"), apps)?;
        if screen["mode"] != "custom" {
            screen["image"] = json!("");
        }
        out.insert("blockScreen".into(), screen);
    }
    out.insert("durationMinutes".into(), json!(duration));
    out.insert("unlockDelayMinutes".into(), json!(delay));
    out.insert("intention".into(), json!(slice16(&string_or(prop(request, "intention"), "Time to focus"), 120)));
    out.insert("apps".into(), Value::Array(apps.iter().map(name_path).collect()));
    Ok(Value::Object(out))
}

/// A real calendar day written as YYYY-MM-DD (the user's local day, so it never shifts with time zones).
pub fn valid_day(day: Option<&Value>) -> bool {
    static SHAPE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$").unwrap());
    let Some(day) = str_of(day).filter(|d| SHAPE.is_match(d)) else { return false };
    let n = |r: std::ops::Range<usize>| day[r].parse::<u32>().unwrap_or(0);
    chrono::NaiveDate::from_ymd_opt(n(0..4) as i32, n(5..7), n(8..10)).is_some()
}

fn is_one_of(v: Option<&Value>, allowed: &[f64]) -> bool {
    matches!(v, Some(Value::Number(n)) if n.as_f64().is_some_and(|f| allowed.contains(&f)))
}
fn is_true(v: Option<&Value>) -> bool {
    v == Some(&Value::Bool(true))
}
fn not_false(v: Option<&Value>) -> bool {
    v != Some(&Value::Bool(false))
}
fn text_in<'a>(v: Option<&'a Value>, allowed: &[&str]) -> Option<&'a str> {
    str_of(v).filter(|s| allowed.contains(s))
}

/// Keeps only known, bounded preference fields (older files default the rest).
pub fn validate_preferences(value: &Value) -> R<Value> {
    if !value.is_object() {
        return err("Invalid preferences.");
    }
    let v = |key: &str| prop(value, key);
    let mut o = Map::new();
    let new_things: Vec<Value> = list(value, "newThings")
        .iter()
        .filter(|i| str_of(prop(i, "text")).is_some_and(|t| !trim(t).is_empty()) && valid_day(prop(i, "day")))
        .take(3000)
        .map(|i| json!({ "text": slice16(trim(str_of(prop(i, "text")).unwrap_or_default()), 120), "day": prop(i, "day"), "done": is_true(prop(i, "done")) }))
        .collect();
    o.insert("newThings".into(), Value::Array(new_things));
    o.insert("blockScreen".into(), websites::screen(v("blockScreen"), &[])?);
    o.insert("websiteLimits".into(), websites::limits(v("websiteLimits")));
    let todo_types = ["checkbox", "circle", "bullet", "number", "heading", "note"];
    let todos: Vec<Value> = list(value, "todos")
        .iter()
        .filter(|i| prop(i, "text").is_some_and(Value::is_string))
        .take(500)
        .map(|i| json!({ "text": slice16(str_of(prop(i, "text")).unwrap_or_default(), 2000), "type": text_in(prop(i, "type"), &todo_types).unwrap_or("checkbox"), "done": is_true(prop(i, "done")) }))
        .collect();
    o.insert("todos".into(), Value::Array(todos));
    o.insert("apps".into(), Value::Array(list(value, "apps").iter().filter(|a| allowed_target(a)).take(300).map(name_path).collect()));
    let strings = |key: &str, max: usize| -> Vec<Value> { list(value, key).iter().filter(|s| s.is_string()).take(max).cloned().collect() };
    o.insert("selected".into(), Value::Array(strings("selected", 100)));
    let groups: Vec<Value> = list(value, "groups")
        .iter()
        .filter(|g| g.is_object() || g.is_array())
        .take(20)
        .map(|g| json!({ "name": slice16(&string_of(prop(g, "name")), 40), "paths": list(g, "paths").iter().filter(|p| p.is_string()).take(100).collect::<Vec<_>>() }))
        .collect();
    o.insert("groups".into(), Value::Array(groups));
    o.insert("duration".into(), num(number_or(v("duration"), 50.0).min(1440.0).max(1.0)));
    o.insert("delay".into(), num(number_or(v("delay"), 5.0).min(120.0).max(1.0)));
    o.insert("delayEnabled".into(), json!(not_false(v("delayEnabled"))));
    o.insert("progressDays".into(), if is_one_of(v("progressDays"), &[7.0, 30.0, 90.0]) { v("progressDays").cloned().unwrap_or_default() } else { json!(30) });
    o.insert("progressMetric".into(), json!(text_in(v("progressMetric"), &["minutes", "sessions"]).unwrap_or("minutes")));
    o.insert("dailyGoal".into(), num(round(number_or(v("dailyGoal"), 60.0)).min(1440.0).max(1.0)));
    o.insert("showIntentions".into(), json!(not_false(v("showIntentions"))));
    o.insert("historyPageSize".into(), if is_one_of(v("historyPageSize"), &[0.0, 10.0, 25.0, 50.0]) { v("historyPageSize").cloned().unwrap_or_default() } else { json!(10) });
    o.insert("intentionSort".into(), json!(text_in(v("intentionSort"), &["time", "recent", "sessions", "name"]).unwrap_or("time")));
    o.insert("intentionScope".into(), json!(if v("intentionScope") == Some(&json!("all")) { "all" } else { "range" }));
    let colors = ["sage", "moss", "lime", "sky", "lavender", "rose", "clay", "sand"];
    let intention_colors: Map<String, Value> = match v("intentionColors") {
        Some(Value::Object(m)) => m.iter().filter(|(label, color)| len16(label) <= 120 && text_in(Some(color), &colors).is_some()).take(300).map(|(k, c)| (k.clone(), c.clone())).collect(),
        _ => Map::new(),
    };
    o.insert("intentionColors".into(), Value::Object(intention_colors));
    o.insert("intention".into(), json!(slice16(&string_or(v("intention"), ""), 120)));
    o.insert("notifications".into(), json!(not_false(v("notifications"))));
    o.insert("reducedMotion".into(), json!(is_true(v("reducedMotion"))));
    o.insert("textSize".into(), if is_one_of(v("textSize"), &[100.0, 115.0, 130.0, 150.0, 175.0]) { v("textSize").cloned().unwrap_or_default() } else { json!(100) });
    for key in ["highContrast", "readableFont", "strongFocus", "launchAtLogin", "alertsAfterQuit", "countAlarmFocus"] {
        o.insert(key.into(), json!(is_true(v(key))));
    }
    Ok(Value::Object(o))
}

/// Compares "1.2.10"-style release versions; anything unparseable is never treated as newer.
pub fn newer_version(latest: &str, current: &str) -> bool {
    let parse = |s: &str| VERSION.captures(s).map(|c| (1..=3).map(|i| c[i].parse::<f64>().unwrap_or(f64::NAN)).collect::<Vec<_>>());
    let (Some(a), Some(b)) = (parse(latest), parse(current)) else { return false };
    a.iter().zip(&b).find(|(x, y)| x != y).is_some_and(|(x, y)| x > y)
}

pub fn update_url(url: Option<&str>) -> String {
    match url {
        Some(u) if u.starts_with(RELEASES) => u.to_string(),
        _ => format!("{RELEASES}latest"),
    }
}

/// True when `actual` is the app page itself: same scheme, host, port and path, with no query or fragment.
pub fn same_page_url(actual: &str, expected: &str) -> bool {
    let (Ok(a), Ok(e)) = (Url::parse(actual), Url::parse(expected)) else { return false };
    a.scheme() == e.scheme() && a.host_str() == e.host_str() && a.port_or_known_default() == e.port_or_known_default() && a.path() == e.path() && a.query().is_none() && a.fragment().is_none()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::iter::repeat_n;

    fn game() -> Value {
        json!({ "name": "A game", "path": "C:\\Games\\Example\\game.exe" })
    }
    fn app(path: &str) -> Value {
        json!({ "name": "App", "path": path })
    }

    #[test]
    fn accept_a_desktop_executable_and_reject_unsafe_targets() {
        assert!(allowed_app(&game()));
        assert!(allowed_app(&json!({ "name": "Spotify", "path": "appx:SpotifyAB.SpotifyMusic_zpdnekdrzrea0" })));
        assert!(!allowed_app(&json!({ "name": "System", "path": "appx:Microsoft.SecHealthUI_8wekyb3d8bbwe" })));
        for file in ["C:\\Windows\\System32\\notepad.exe", "C:\\Tools\\powershell.exe", "C:\\Tools\\POWERSHELL.EXE", "C:\\Apps\\Still.exe", "C:\\Games\\*.exe", "relative.exe", "C:\\Games\\game.cmd", "C:\\Program Files\\WindowsApps\\game.exe"] {
            assert!(!allowed_app(&app(file)), "{file}");
        }
    }

    #[test]
    fn validate_durations_delay_and_app_bounds() {
        let request = json!({ "durationMinutes": 50, "unlockDelayMinutes": 5, "intention": "Write a chapter", "apps": [game()] });
        assert_eq!(validate_session(&request).unwrap(), request);
        let with = |key: &str, v: Value| {
            let mut r = request.clone();
            r[key] = v;
            r
        };
        for minutes in [json!(0), json!(-1), json!(1441), json!(null), json!(1.5), json!("25")] {
            assert!(validate_session(&with("durationMinutes", minutes)).is_err());
        }
        for delay in [json!(-1), json!(121), json!(null), json!(0.5)] {
            assert!(validate_session(&with("unlockDelayMinutes", delay)).is_err());
        }
        assert!(validate_session(&with("unlockDelayMinutes", json!(0))).is_ok());
        assert!(validate_session(&with("apps", json!([]))).is_err());
        assert!(validate_session(&with("apps", Value::Array(repeat_n(game(), 101).collect()))).is_err());
        assert_eq!(len16(validate_session(&with("intention", json!("a".repeat(200)))).unwrap()["intention"].as_str().unwrap()), 120);
    }

    #[test]
    fn website_selections_survive_sessions_and_preferences() {
        let site = websites::target("https://youtube.com/watch").unwrap();
        assert!(!allowed_app(&site), "Discovery still accepts native apps only");
        let request = json!({ "durationMinutes": 25, "unlockDelayMinutes": 5, "apps": [site], "intention": "Write" });
        let session = validate_session(&request).unwrap();
        assert_eq!(session["apps"], json!([site]));
        assert_eq!(session["blockScreen"]["mode"], "garden");
        let prefs = validate_preferences(&json!({ "apps": [site], "selected": [site["path"]], "groups": [{ "name": "Quiet", "paths": [site["path"]] }], "blockScreen": { "mode": "custom", "title": "<hello>", "text": "Keep going", "image": "data:image/png;base64,AAAA" } })).unwrap();
        assert_eq!(prefs["apps"], json!([site]));
        assert_eq!(prefs["groups"][0]["paths"], json!([site["path"]]));
        assert_eq!(prefs["blockScreen"]["title"], "<hello>");
        let mut bad = request;
        bad["apps"] = json!([{ "name": "Bad", "path": "website:localhost" }]);
        assert!(validate_session(&bad).is_err());
    }

    #[test]
    fn persist_only_bounded_known_preferences() {
        let result = validate_preferences(&json!({ "apps": [{ "name": "A game", "path": "C:\\Games\\Example\\game.exe", "icon": "untrusted", "extra": true }, { "path": "evil", "name": "bad" }], "duration": 9999, "delay": -4, "arbitraryCode": "no", "selected": ["C:\\Games\\Example\\game.exe", null], "groups": [{ "name": "A".repeat(50), "paths": ["C:\\Games\\Example\\game.exe", false] }] })).unwrap();
        assert_eq!(result["apps"], json!([game()]));
        assert_eq!(result["duration"], 1440);
        assert_eq!(result["delay"], 1);
        assert!(result.get("arbitraryCode").is_none());
        assert_eq!(len16(result["groups"][0]["name"].as_str().unwrap()), 40);
        assert_eq!(result["selected"], json!(["C:\\Games\\Example\\game.exe"]));
        assert_eq!(result["groups"][0]["paths"], json!(["C:\\Games\\Example\\game.exe"]));
    }

    #[test]
    fn persist_only_known_accessibility_options() {
        let pick = |p: &Value| json!({ "textSize": p["textSize"], "highContrast": p["highContrast"], "readableFont": p["readableFont"], "strongFocus": p["strongFocus"], "reducedMotion": p["reducedMotion"] });
        assert_eq!(pick(&validate_preferences(&json!({})).unwrap()), json!({ "textSize": 100, "highContrast": false, "readableFont": false, "strongFocus": false, "reducedMotion": false }));
        let all = json!({ "textSize": 175, "highContrast": true, "readableFont": true, "strongFocus": true, "reducedMotion": true });
        assert_eq!(pick(&validate_preferences(&all).unwrap()), all);
        for size in [json!(0), json!(99), json!(200), json!(1000), json!("150"), json!(null)] {
            assert_eq!(validate_preferences(&json!({ "textSize": size })).unwrap()["textSize"], 100);
        }
        assert_eq!(validate_preferences(&json!({ "highContrast": "yes", "readableFont": 1, "strongFocus": "true" })).unwrap()["highContrast"], false);
    }

    #[test]
    fn persist_bounded_todos_and_new_things() {
        let todos = validate_preferences(&json!({ "todos": [null, { "text": 9 }, { "text": "x".repeat(2001), "type": "script", "done": "yes" }, { "text": "Read", "type": "circle", "done": true }] })).unwrap()["todos"].clone();
        assert_eq!(todos, json!([{ "text": "x".repeat(2000), "type": "checkbox", "done": false }, { "text": "Read", "type": "circle", "done": true }]));
        assert_eq!(validate_preferences(&json!({ "todos": repeat_n(json!({ "text": "" }), 501).collect::<Vec<_>>() })).unwrap()["todos"].as_array().unwrap().len(), 500);
        let kept = validate_preferences(&json!({ "newThings": [null, { "text": "  Try pottery  ", "day": "2026-10-16", "done": true }, { "text": "x".repeat(200), "day": "2024-02-29", "done": "yes" }, { "text": "   ", "day": "2026-10-16" }, { "text": "Bad day", "day": "2026-02-30" }, { "text": "Bad month", "day": "2026-13-01" }, { "text": "No day" }, { "text": 7, "day": "2026-10-16" }] })).unwrap()["newThings"].clone();
        assert_eq!(kept, json!([{ "text": "Try pottery", "day": "2026-10-16", "done": true }, { "text": "x".repeat(120), "day": "2024-02-29", "done": false }]));
        assert_eq!(validate_preferences(&json!({ "newThings": repeat_n(json!({ "text": "a", "day": "2026-10-16" }), 3001).collect::<Vec<_>>() })).unwrap()["newThings"].as_array().unwrap().len(), 3000);
    }

    #[test]
    fn compare_release_versions_and_only_open_still_downloads() {
        assert!(newer_version("v1.10.0", "1.9.3"));
        assert!(newer_version("1.0.1", "1.0.0"));
        for (latest, current) in [("1.0.0", "1.0.0"), ("0.9.9", "1.0.0"), ("1.1.0-beta", "1.0.0"), ("", "1.0.0"), ("undefined", "1.0.0")] {
            assert!(!newer_version(latest, current), "{latest}");
        }
        let asset = "https://github.com/limpy183-dev/Still/releases/download/v1.1.0/Still-Setup-1.1.0.exe";
        assert_eq!(update_url(Some(asset)), asset);
        for url in ["https://example.com/Still-Setup.exe", "https://github.com/other/Still/releases/latest", "file:///C:/x.exe"] {
            assert_eq!(update_url(Some(url)), "https://github.com/limpy183-dev/Still/releases/latest");
        }
        assert_eq!(update_url(None), "https://github.com/limpy183-dev/Still/releases/latest");
    }

    #[test]
    fn page_urls_must_match_exactly() {
        let page = "https://still.localhost/index.html";
        assert!(same_page_url(page, page));
        for other in ["https://still.localhost/index.html?x=1", "https://still.localhost/index.html#x", "https://evil.example/index.html", "https://still.localhost/alarm.html", "nonsense"] {
            assert!(!same_page_url(other, page), "{other}");
        }
    }
}
