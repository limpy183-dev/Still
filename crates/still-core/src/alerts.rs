//! Port of `app/alert-domain.cjs`: alert validation, occurrence maths and the "Alarms after you quit" wake task.
//! Calendar maths take the time zone as a parameter (production passes `chrono::Local`) and follow
//! JavaScript `Date` rules for daylight-saving gaps and repeats.
use crate::{domain, js::*, session::TargetApp};
use chrono::{Datelike, Duration, NaiveDate, NaiveDateTime, NaiveTime, Offset, TimeZone, Timelike};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::sync::LazyLock;

pub const SOUNDS: [&str; 6] = ["chime", "bloom", "bell", "pulse", "silent", "custom"];
pub static MEDIA_FILE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^[a-f0-9-]{36}\.(mp3|wav|ogg|m4a|aac|flac|mp4|mov|webm|png|jpe?g|gif|webp)$").unwrap());
static CLOCK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^([01][0-9]|2[0-3]):[0-5][0-9]$").unwrap());
static DAY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$").unwrap());

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Media {
    pub file: String,
    pub name: String,
}

/// A focus window the alert is waiting to start blocking for.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Pending {
    pub start: i64,
    pub end: i64,
    pub apps: Vec<TargetApp>,
}

fn yes() -> bool {
    true
}

/// A saved alert: the validated fields plus the scheduler's bookkeeping. Bookkeeping fields stay absent until
/// they are first set, as in the original `alerts.json`; unknown fields are preserved.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Alert {
    #[serde(default)]
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub note: String,
    pub date: String,
    pub time: String,
    pub repeat: String,
    pub length_mode: String,
    pub duration_minutes: i64,
    pub end_time: String,
    pub style: String,
    #[serde(default)]
    pub snooze_limit: Option<i64>,
    #[serde(default = "yes")]
    pub show_dismiss: bool,
    #[serde(default = "yes")]
    pub on_top: bool,
    pub block_mode: String,
    #[serde(default)]
    pub apps: Vec<TargetApp>,
    pub unlock_delay_minutes: i64,
    pub sound: String,
    #[serde(serialize_with = "crate::js::serialize_num")]
    pub volume: f64,
    #[serde(default)]
    pub sound_file: Option<Media>,
    #[serde(default)]
    pub banner: Option<Media>,
    #[serde(default = "yes")]
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snooze_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "nullable")]
    pub pending: Option<Option<Pending>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_result: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_occurrence: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snooze_count: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "nullable")]
    pub session_id: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snooze_end: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub occurrence_apps: Option<Vec<TargetApp>>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// Keeps a stored `null` distinct from an absent field (`Some(None)` versus `None`).
fn nullable<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(d: D) -> Result<Option<Option<T>>, D::Error> {
    Option::<T>::deserialize(d).map(Some)
}

impl Alert {
    pub fn last_occurrence(&self) -> i64 {
        self.last_occurrence.unwrap_or(0)
    }
    pub fn pending(&self) -> Option<&Pending> {
        self.pending.as_ref().and_then(Option::as_ref)
    }
    pub fn session_id(&self) -> Option<&str> {
        self.session_id.as_ref().and_then(|s| s.as_deref())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct Occurrence {
    pub start: i64,
    pub end: i64,
}

/// Parses `YYYY-MM-DD` as a real local calendar day.
pub fn local_date(value: Option<&Value>) -> R<NaiveDate> {
    let invalid = || "Choose a valid date.".to_string();
    let text = str_of(value).filter(|s| DAY.is_match(s)).ok_or_else(invalid)?;
    let n = |r: std::ops::Range<usize>| text[r].parse::<u32>().unwrap_or(0);
    NaiveDate::from_ymd_opt(n(0..4) as i32, n(5..7), n(8..10)).ok_or_else(invalid)
}

/// Milliseconds for local wall time `h:m` on `day`, resolved like JS `Date#setHours`:
/// a repeated hour takes its first occurrence and a skipped hour moves forward.
fn at_time<Tz: TimeZone>(tz: &Tz, day: NaiveDate, h: u32, m: u32) -> i64 {
    let naive = NaiveDateTime::new(day, NaiveTime::from_hms_opt(h, m, 0).unwrap_or_default());
    match tz.from_local_datetime(&naive) {
        chrono::LocalResult::Single(t) => t.timestamp_millis(),
        chrono::LocalResult::Ambiguous(first, _) => first.timestamp_millis(),
        chrono::LocalResult::None => {
            let before = tz.from_local_datetime(&(naive - Duration::hours(3))).earliest().map(|t| t.offset().fix().local_minus_utc()).unwrap_or(0);
            naive.and_utc().timestamp_millis() - i64::from(before) * 1000
        }
    }
}

fn hm(text: &str) -> (u32, u32) {
    (text[0..2].parse().unwrap_or(0), text[3..5].parse().unwrap_or(0))
}

fn day_of<Tz: TimeZone>(tz: &Tz, ms: i64) -> NaiveDate {
    tz.timestamp_millis_opt(ms).single().map(|t| t.date_naive()).unwrap_or_default()
}

pub fn occurrence_on<Tz: TimeZone>(tz: &Tz, alert: &Alert, day: NaiveDate) -> Option<Occurrence> {
    let start_day = local_date(Some(&Value::String(alert.date.clone()))).ok()?;
    if day < start_day || (alert.repeat == "once" && day != start_day) || (alert.repeat == "weekdays" && matches!(day.weekday().num_days_from_sunday(), 0 | 6)) {
        return None;
    }
    let (h, m) = hm(&alert.time);
    let start = at_time(tz, day, h, m);
    let mut end = start + alert.duration_minutes * 60000;
    if alert.length_mode == "range" {
        let end_day = if alert.end_time < alert.time { day + Duration::days(1) } else { day };
        let (eh, em) = hm(&alert.end_time);
        end = at_time(tz, end_day, eh, em);
    }
    Some(Occurrence { start, end })
}

pub fn due_occurrence<Tz: TimeZone>(tz: &Tz, alert: &Alert, now: i64) -> Option<Occurrence> {
    if !alert.enabled {
        return None;
    }
    let last = alert.last_occurrence();
    if alert.repeat == "once" {
        let start_day = local_date(Some(&Value::String(alert.date.clone()))).ok()?;
        let o = occurrence_on(tz, alert, start_day)?;
        return (o.start <= now && o.start > last).then_some(o);
    }
    // A wake/relaunch catches up today's slot (or yesterday's overnight slot), never a backlog.
    let today = day_of(tz, now);
    [0, -1].into_iter().find_map(|offset| occurrence_on(tz, alert, today + Duration::days(offset)).filter(|o| o.start <= now && o.start > last))
}

/// Saving or switching an alert on skips a window that has already ended, so it doesn't ring as a late reminder.
pub fn skip_ended<Tz: TimeZone>(tz: &Tz, alert: &Alert, now: i64) -> i64 {
    match due_occurrence(tz, alert, now) {
        Some(due) if due.end <= now => due.start,
        _ => alert.last_occurrence(),
    }
}

pub fn next_occurrence<Tz: TimeZone>(tz: &Tz, alert: &Alert, now: i64) -> Option<i64> {
    if !alert.enabled {
        return None;
    }
    if let Some(due) = due_occurrence(tz, alert, now).filter(|d| d.end > now) {
        return Some(due.start);
    }
    let start_day = local_date(Some(&Value::String(alert.date.clone()))).ok()?;
    let first_day = day_of(tz, now).max(start_day);
    let last = alert.last_occurrence();
    for offset in 0..8 {
        if let Some(o) = occurrence_on(tz, alert, first_day + Duration::days(offset)).filter(|o| o.start > now && o.start > last) {
            return Some(o.start);
        }
    }
    // One-time alerts may be months away.
    if alert.repeat == "once" {
        return occurrence_on(tz, alert, start_day).filter(|o| o.start > now).map(|o| o.start);
    }
    None
}

fn is_clock(v: Option<&Value>) -> bool {
    str_of(v).is_some_and(|s| CLOCK.is_match(s))
}

fn one_of(v: Option<&Value>, list: &[&str]) -> bool {
    str_of(v).is_some_and(|s| list.contains(&s))
}

/// Validates an alert at the IPC boundary; returns only the known fields, in the original order.
pub fn validate_alert(value: &Value) -> R<Value> {
    if !value.is_object() {
        return err("Invalid alert.");
    }
    let v = |key: &str| prop(value, key);
    let title = trim(&string_or(v("title"), "")).to_string();
    if title.is_empty() || len16(&title) > 120 {
        return err("Give your alert a task, up to 120 characters.");
    }
    local_date(v("date"))?;
    if !is_clock(v("time")) {
        return err("Choose a valid start time.");
    }
    if !one_of(v("repeat"), &["once", "daily", "weekdays"]) {
        return err("Choose a repeat schedule.");
    }
    if !one_of(v("lengthMode"), &["duration", "range"]) {
        return err("Choose a duration or time range.");
    }
    let Some(duration) = integer(v("durationMinutes")).filter(|d| (1..=1440).contains(d)) else {
        return err("Choose 1–1,440 whole minutes.");
    };
    if !is_clock(v("endTime")) {
        return err("Choose a valid end time.");
    }
    if str_of(v("lengthMode")) == Some("range") && v("endTime") == v("time") {
        return err("Start and end times must be different.");
    }
    if !one_of(v("style"), &["full", "card", "notification"]) {
        return err("Choose an alarm style.");
    }
    let snooze_limit = v("snoozeLimit").filter(|x| !x.is_null());
    let snooze_limit = match snooze_limit {
        None => None,
        Some(x) => Some(integer(Some(x)).filter(|n| (0..=100).contains(n)).ok_or("Choose 0–100 snoozes, or unlimited.")?),
    };
    if v("showDismiss").is_some_and(|x| !x.is_boolean()) {
        return err("Choose whether to show Dismiss.");
    }
    if v("onTop").is_some_and(|x| !x.is_boolean()) {
        return err("Choose whether the alarm stays above other apps.");
    }
    if !one_of(v("blockMode"), &["none", "current", "custom"]) {
        return err("Choose which apps or websites to block.");
    }
    let apps = match v("apps") {
        Some(Value::Array(a)) if a.len() <= 100 && a.iter().all(domain::allowed_target) => a.as_slice(),
        _ => return err("Choose up to 100 apps or websites."),
    };
    if str_of(v("blockMode")) == Some("custom") && apps.is_empty() {
        return err("Select apps or websites to block, or choose “No blocking”.");
    }
    let Some(delay) = integer(v("unlockDelayMinutes")).filter(|d| (0..=120).contains(d)) else {
        return err("Choose a release delay from 0 to 120 minutes.");
    };
    let sound = str_of(v("sound")).filter(|s| SOUNDS.contains(s)).unwrap_or("");
    let volume = match v("volume") {
        Some(Value::Number(n)) => n.as_f64().filter(|f| (0.0..=100.0).contains(f)),
        _ => None,
    };
    let (true, Some(volume)) = (!sound.is_empty(), volume) else { return err("Choose a sound and volume.") };
    let asset = |item: Option<&Value>| -> R<Value> {
        if !truthy(item) {
            return Ok(Value::Null);
        }
        let file = str_of(prop(item.unwrap(), "file")).filter(|f| MEDIA_FILE.is_match(f));
        let name = str_of(prop(item.unwrap(), "name"));
        match (file, name) {
            (Some(file), Some(name)) => Ok(serde_json::json!({ "file": file, "name": slice16(name, 200) })),
            _ => err("Choose a media file using the file picker."),
        }
    };
    let (sound_file, banner) = (asset(v("soundFile"))?, asset(v("banner"))?);
    if sound == "custom" && sound_file.is_null() {
        return err("Choose your custom sound file.");
    }
    let style = str_of(v("style")).unwrap_or("");
    if style == "full" && (sound == "silent" || volume == 0.0) {
        return err("Full-screen alarms need an audible sound.");
    }
    let apps: Vec<Value> = apps.iter().map(|a| serde_json::json!({ "name": slice16(str_of(prop(a, "name")).unwrap_or_default(), 100), "path": prop(a, "path") })).collect();
    let mut o = Map::new();
    let mut put = |k: &str, x: Value| {
        o.insert(k.into(), x);
    };
    put("title", title.into());
    put("note", slice16(&string_or(v("note"), ""), 500).into());
    for key in ["date", "time", "repeat", "lengthMode"] {
        put(key, v(key).cloned().unwrap_or_default());
    }
    put("durationMinutes", duration.into());
    put("endTime", v("endTime").cloned().unwrap_or_default());
    put("style", style.into());
    put("snoozeLimit", snooze_limit.map_or(Value::Null, Into::into));
    put("showDismiss", (v("showDismiss") != Some(&Value::Bool(false))).into());
    put("onTop", (v("onTop") != Some(&Value::Bool(false))).into());
    put("blockMode", v("blockMode").cloned().unwrap_or_default());
    put("apps", Value::Array(apps));
    put("unlockDelayMinutes", delay.into());
    put("sound", sound.into());
    put("volume", v("volume").cloned().unwrap_or_default());
    put("soundFile", sound_file);
    put("banner", banner);
    put("enabled", (v("enabled") != Some(&Value::Bool(false))).into());
    Ok(Value::Object(o))
}

/// A one-shot Task Scheduler task that reopens Still (hidden) before the next alert after it quits.
/// StartWhenAvailable runs it after sleep or sign-in if the time was missed; PT0S stops Windows ending Still after 72 hours.
pub fn wake_task_xml<Tz: TimeZone>(tz: &Tz, at: i64, command: &str, args: &str) -> String {
    let d = tz.timestamp_millis_opt(at).single().map(|t| t.naive_local()).unwrap_or_default();
    let escape = |s: &str| s.chars().map(|c| if matches!(c, '<' | '>' | '&' | '\'' | '"') { format!("&#{};", c as u32) } else { c.to_string() }).collect::<String>();
    format!(
        r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Reopens Still in the background so your alerts ring after you quit it. Turn off "Alarms after you quit" in Still's Settings to remove it.</Description></RegistrationInfo>
  <Triggers><TimeTrigger><StartBoundary>{:04}-{:02}-{:02}T{:02}:{:02}:{:02}</StartBoundary><Enabled>true</Enabled></TimeTrigger></Triggers>
  <Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><Priority>5</Priority></Settings>
  <Actions Context="Author"><Exec><Command>{}</Command><Arguments>{}</Arguments></Exec></Actions>
</Task>"#,
        d.year(), d.month(), d.day(), d.hour(), d.minute(), d.second(), escape(command), escape(args)
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono_tz::{Europe::London, Tz, US::Eastern};
    use serde_json::json;

    fn base() -> Value {
        json!({ "title": "Write a chapter", "note": "", "date": "2026-09-23", "time": "09:00", "repeat": "once", "lengthMode": "duration", "durationMinutes": 50, "endTime": "10:00", "style": "card", "blockMode": "none", "apps": [], "unlockDelayMinutes": 5, "sound": "chime", "volume": 65, "enabled": true })
    }
    fn with(change: Value) -> Value {
        let mut b = base();
        for (k, v) in change.as_object().unwrap() {
            b[k] = v.clone();
        }
        b
    }
    fn alert(change: Value) -> Alert {
        serde_json::from_value(validate_alert(&with(change)).unwrap()).unwrap()
    }
    fn at(tz: &Tz, text: &str) -> i64 {
        let naive = NaiveDateTime::parse_from_str(text, "%Y-%m-%dT%H:%M:%S").unwrap();
        tz.from_local_datetime(&naive).earliest().unwrap().timestamp_millis()
    }

    #[test]
    fn alert_boundary_rejects_unsafe_apps_invalid_schedules_and_silent_full_screen() {
        let ok = validate_alert(&base()).unwrap();
        assert_eq!(ok["title"], "Write a chapter");
        assert_eq!(ok["snoozeLimit"], Value::Null);
        assert_eq!(ok["showDismiss"], true);
        assert_eq!(ok["onTop"], true);
        assert_eq!(validate_alert(&with(json!({ "onTop": false }))).unwrap()["onTop"], false);
        assert!(validate_alert(&with(json!({ "onTop": "no" }))).is_err());
        for limit in [json!(-1), json!(1.5), json!(101), json!("2")] {
            assert!(validate_alert(&with(json!({ "snoozeLimit": limit }))).is_err());
        }
        assert!(validate_alert(&with(json!({ "showDismiss": "false" }))).is_err());
        for change in [
            json!({ "title": "" }), json!({ "time": "25:00" }), json!({ "date": "2026-02-30" }), json!({ "durationMinutes": 0 }), json!({ "durationMinutes": 1.5 }),
            json!({ "repeat": "hourly" }), json!({ "blockMode": "custom" }), json!({ "apps": [{ "name": "Windows", "path": "C:\\Windows\\explorer.exe" }] }),
            json!({ "sound": "custom" }), json!({ "style": "full", "volume": 0 }), json!({ "style": "full", "sound": "silent" }),
            json!({ "banner": { "file": "../../private.png", "name": "bad" } }), json!({ "lengthMode": "range", "endTime": "09:00" }),
        ] {
            assert!(validate_alert(&with(change.clone())).is_err(), "{change}");
        }
    }

    #[test]
    fn one_time_missed_and_consumed_occurrences_never_duplicate() {
        let tz = Eastern;
        let a = alert(json!({}));
        let now = at(&tz, "2026-09-23T09:01:00");
        assert_eq!(due_occurrence(&tz, &a, now).unwrap().start, at(&tz, "2026-09-23T09:00:00"));
        let consumed = Alert { last_occurrence: Some(at(&tz, "2026-09-23T09:00:00")), ..a.clone() };
        assert_eq!(due_occurrence(&tz, &consumed, now), None);
        assert_eq!(due_occurrence(&tz, &a, at(&tz, "2026-09-23T08:59:00")), None);
        assert_eq!(next_occurrence(&tz, &Alert { enabled: false, ..a.clone() }, now), None);
        assert_eq!(next_occurrence(&tz, &a, at(&tz, "2026-09-23T10:00:00")), None);
        assert!(due_occurrence(&tz, &a, at(&tz, "2026-09-24T10:00:00")).unwrap().end < at(&tz, "2026-09-24T10:00:00"));
    }

    #[test]
    fn saving_an_alert_skips_a_window_that_already_ended() {
        let tz = Eastern;
        let daily = alert(json!({ "repeat": "daily" }));
        let noon = at(&tz, "2026-09-25T12:00:00");
        let saved = Alert { last_occurrence: Some(skip_ended(&tz, &daily, noon)), ..daily.clone() };
        assert_eq!(saved.last_occurrence(), at(&tz, "2026-09-25T09:00:00"));
        assert_eq!(due_occurrence(&tz, &saved, noon), None);
        assert_eq!(next_occurrence(&tz, &saved, noon), Some(at(&tz, "2026-09-26T09:00:00")));
        assert_eq!(skip_ended(&tz, &daily, at(&tz, "2026-09-25T09:10:00")), 0, "Still inside its window: it rings now.");
    }

    #[test]
    fn overnight_ranges_and_future_start_dates_use_local_calendar_days() {
        let tz = Eastern;
        let overnight = alert(json!({ "time": "23:30", "lengthMode": "range", "endTime": "01:00", "repeat": "daily" }));
        let due = due_occurrence(&tz, &overnight, at(&tz, "2026-09-24T00:15:00")).unwrap();
        assert_eq!((due.start, due.end), (at(&tz, "2026-09-23T23:30:00"), at(&tz, "2026-09-24T01:00:00")));
        assert_eq!(next_occurrence(&tz, &alert(json!({ "repeat": "weekdays" })), at(&tz, "2026-09-25T11:00:00")), Some(at(&tz, "2026-09-28T09:00:00")));
        assert_eq!(next_occurrence(&tz, &alert(json!({ "date": "2027-01-04", "repeat": "daily" })), at(&tz, "2026-09-23T11:00:00")), Some(at(&tz, "2027-01-04T09:00:00")));
    }

    #[test]
    fn short_windows_keep_seconds_and_dst_ranges_follow_the_wall_clock() {
        let minute = occurrence_on(&London, &alert(json!({ "durationMinutes": 1 })), NaiveDate::from_ymd_opt(2026, 9, 23).unwrap()).unwrap();
        assert_eq!(minute.end - minute.start, 60000);
        let range = |date: &str| alert(json!({ "date": date, "time": "23:30", "lengthMode": "range", "endTime": "02:30" }));
        let fall = occurrence_on(&London, &range("2026-10-24"), NaiveDate::from_ymd_opt(2026, 10, 24).unwrap()).unwrap();
        assert_eq!(fall.end - fall.start, 4 * 3_600_000);
        let spring = occurrence_on(&London, &range("2026-03-28"), NaiveDate::from_ymd_opt(2026, 3, 28).unwrap()).unwrap();
        assert_eq!(spring.end - spring.start, 2 * 3_600_000);
    }

    #[test]
    fn wake_task_survives_unusual_paths_and_never_expires() {
        let tz = Eastern;
        let xml = wake_task_xml(&tz, at(&tz, "2026-09-23T08:59:30"), "C:\\Users\\Zoë O'Neil\\R&D <1>\\Still.exe", "--alarm-wake");
        assert!(xml.contains("<StartBoundary>2026-09-23T08:59:30</StartBoundary>"));
        assert!(xml.contains("<Command>C:\\Users\\Zoë O&#39;Neil\\R&#38;D &#60;1&#62;\\Still.exe</Command>"));
        for setting in ["<StartWhenAvailable>true", "<ExecutionTimeLimit>PT0S", "<DisallowStartIfOnBatteries>false", "<RunLevel>LeastPrivilege", "<Arguments>--alarm-wake<"] {
            assert!(xml.contains(setting), "{setting}");
        }
    }

    #[test]
    fn a_saved_alert_round_trips_without_gaining_or_losing_fields() {
        let stored = json!({ "id": "x", "title": "T", "note": "", "date": "2026-09-23", "time": "09:00", "repeat": "once", "lengthMode": "duration", "durationMinutes": 5, "endTime": "10:00", "style": "card", "snoozeLimit": null, "showDismiss": true, "onTop": true, "blockMode": "none", "apps": [], "unlockDelayMinutes": 0, "sound": "chime", "volume": 65, "soundFile": null, "banner": null, "enabled": true, "snoozeAt": 0, "pending": null, "lastResult": "", "lastOccurrence": 0, "futureField": 1 });
        let parsed: Alert = serde_json::from_value(stored.clone()).unwrap();
        assert_eq!(serde_json::to_value(&parsed).unwrap(), stored);
    }
}
