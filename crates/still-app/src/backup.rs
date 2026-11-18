//! Moving Still to another PC. Everything the app keeps (settings, to-dos, alerts with the sounds and banners they use,
//! session history) goes into one zip and comes back from one. Windows protection is not part of it: the new PC sets it up again.
use crate::{
    alerts::parse_alerts,
    app::App,
    win,
};
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    fs::File,
    io::{self, Read, Write},
    path::Path,
    rc::Rc,
};
use still_core::{
    alerts::{Alert, MEDIA_FILE},
    session::{FocusSession, now_ms},
};
use zip::{CompressionMethod, ZipArchive, ZipWriter, result::ZipError, write::SimpleFileOptions};

const FORMAT: u64 = 1;
const MAX_TEXT: u64 = 8 << 20; // a settings, alerts or history file
const MAX_MEDIA: u64 = 200 << 20; // the same limit as choosing a sound or banner
const NOT_A_BACKUP: &str = "This is not a Still backup. Choose a .zip file made with Export backup.";

/// What a backup holds, as the JSON files inside it.
struct Snapshot {
    prefs: Value,
    alerts: Value,
    history: Value,
}

struct Loaded {
    prefs: Value,
    alerts: Vec<Alert>,
    history: Vec<Value>,
}

fn media_names(alerts: &Value) -> BTreeSet<String> {
    let files = alerts.as_array().into_iter().flatten().flat_map(|a| [&a["soundFile"], &a["banner"]]);
    files.filter_map(|m| m["file"].as_str()).filter(|f| MEDIA_FILE.is_match(f)).map(String::from).collect()
}

fn build_zip(path: &Path, media_dir: &Path, snapshot: &Snapshot) -> Result<(), String> {
    let e = |e: &dyn std::fmt::Display| e.to_string();
    let mut zip = ZipWriter::new(File::create(path).map_err(|x| e(&x))?);
    let manifest = json!({ "app": "Still", "format": FORMAT, "version": env!("CARGO_PKG_VERSION"), "createdAt": now_ms() });
    let files = [("manifest.json", &manifest), ("preferences.json", &snapshot.prefs), ("alerts.json", &snapshot.alerts), ("history.json", &snapshot.history)];
    for (name, value) in files {
        zip.start_file(name, SimpleFileOptions::default()).map_err(|x| e(&x))?;
        zip.write_all(serde_json::to_string_pretty(value).map_err(|x| e(&x))?.as_bytes()).map_err(|x| e(&x))?;
    }
    for name in media_names(&snapshot.alerts) {
        // A sound that went missing is skipped; its alert falls back to the chime, as it does here.
        let Ok(mut source) = File::open(media_dir.join(&name)) else { continue };
        zip.start_file(format!("alert-media/{name}"), SimpleFileOptions::default().compression_method(CompressionMethod::Stored)).map_err(|x| e(&x))?;
        io::copy(&mut source, &mut zip).map_err(|x| e(&x))?;
    }
    zip.finish().map(|_| ()).map_err(|x| e(&x))
}

/// Writes next to the target and renames, so a failed export never leaves half a zip (or damages an older one).
fn write_zip(file: &Path, media_dir: &Path, snapshot: &Snapshot) -> Result<(), String> {
    let tmp = file.with_file_name(format!("{}.tmp", file.file_name().unwrap_or_default().to_string_lossy()));
    let done = build_zip(&tmp, media_dir, snapshot).and_then(|()| std::fs::rename(&tmp, file).map_err(|e| e.to_string()));
    if done.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    done
}

fn read_text(zip: &mut ZipArchive<File>, name: &str) -> Result<Option<Value>, String> {
    let entry = match zip.by_name(name) {
        Ok(entry) => entry,
        Err(ZipError::FileNotFound) => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    let damaged = || format!("{name} in the backup is damaged.");
    let mut text = String::new();
    entry.take(MAX_TEXT + 1).read_to_string(&mut text).map_err(|_| damaged())?;
    if text.len() as u64 > MAX_TEXT {
        return Err(format!("{name} in the backup is too large."));
    }
    serde_json::from_str(text.trim_start_matches('\u{feff}')).map(Some).map_err(|_| damaged())
}

fn read_list(zip: &mut ZipArchive<File>, name: &str) -> Result<Vec<Value>, String> {
    match read_text(zip, name)? {
        None => Ok(Vec::new()),
        Some(Value::Array(list)) => Ok(list),
        Some(_) => Err(format!("{name} in the backup is damaged.")),
    }
}

/// A history record from a backup, in the shape Windows protection returns (alarm focus windows keep their flag).
/// Anything that is not a finished session is dropped, and so is block-screen artwork, which history never keeps.
fn session_record(raw: &Value) -> Option<Value> {
    let mut session: FocusSession = serde_json::from_value(raw.clone()).ok()?;
    if session.id.is_empty() || session.id.len() > 100 || session.started_at <= 0 || session.ends_at <= 0 || session.finished_at <= 0 {
        return None;
    }
    session.block_screen = None;
    session.apps.truncate(300);
    session.intention = session.intention.map(|text| text.chars().take(120).collect());
    let mut record = serde_json::to_value(&session).ok()?;
    if raw["alarm"] == true {
        record["alarm"] = json!(true);
    }
    Some(record)
}

/// Reads and checks a backup. Nothing but the alerts' sounds and banners is written to disk here, and those only under
/// names that pass the same check as an alert's own files, so a hand-made zip cannot place a file anywhere else.
fn read_backup(file: &Path, media_dir: &Path) -> Result<Loaded, String> {
    let mut zip = File::open(file).map_err(|e| e.to_string()).and_then(|f| ZipArchive::new(f).map_err(|_| NOT_A_BACKUP.to_string()))?;
    let manifest = read_text(&mut zip, "manifest.json").ok().flatten().filter(|m| m["app"] == "Still").ok_or(NOT_A_BACKUP)?;
    if manifest["format"].as_u64().is_none_or(|format| format > FORMAT) {
        return Err("This backup was made by a newer Still. Update Still, then import it again.".into());
    }
    let prefs = read_text(&mut zip, "preferences.json")?.filter(Value::is_object).ok_or("This backup has no settings in it.")?;
    let alerts = parse_alerts(read_list(&mut zip, "alerts.json")?)?;
    let history = read_list(&mut zip, "history.json")?.iter().take(500).filter_map(session_record).collect();
    std::fs::create_dir_all(media_dir).map_err(|e| e.to_string())?;
    let wanted: BTreeSet<&str> = alerts.iter().flat_map(|a| [&a.sound_file, &a.banner]).flatten().map(|m| m.file.as_str()).collect();
    for name in wanted {
        if media_dir.join(name).exists() {
            continue;
        }
        let Ok(entry) = zip.by_name(&format!("alert-media/{name}")) else { continue };
        let tmp = media_dir.join(format!("{name}.tmp"));
        let copied = File::create(&tmp).and_then(|mut out| io::copy(&mut entry.take(MAX_MEDIA + 1), &mut out));
        match copied {
            Ok(size) if size <= MAX_MEDIA => std::fs::rename(&tmp, media_dir.join(name)).map_err(|e| e.to_string())?,
            other => {
                let _ = std::fs::remove_file(&tmp);
                return Err(other.err().map_or_else(|| "A sound or banner in the backup is larger than 200 MB.".to_string(), |e| e.to_string()));
            }
        }
    }
    Ok(Loaded { prefs, alerts, history })
}

/// The data as it is now. History is Windows protection's plus what Still keeps itself; when protection can't be reached
/// only the second part is available, and the second value says so.
async fn snapshot(app: &Rc<App>) -> (Snapshot, bool) {
    let status = app.status(true).await;
    let alerts = app.alerts.borrow().clone();
    let reachable = status.get("unavailable") != Some(&Value::Bool(true));
    let history = if reachable { status["history"].clone() } else { Value::Array(alerts.as_ref().map(|a| a.focus_history(now_ms()).0).unwrap_or_default()) };
    let snapshot = Snapshot { prefs: (*app.prefs()).clone(), alerts: Value::Array(alerts.map(|a| a.records_json()).unwrap_or_default()), history };
    (snapshot, reachable)
}

fn media_dir(app: &App) -> std::path::PathBuf {
    app.mode.user_data.join("alert-media")
}

async fn blocking<T: Send + 'static>(work: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tokio::task::spawn_blocking(work).await.map_err(|e| e.to_string())?
}

/// "Export backup": asks where to save the zip. Answers `false` if that was cancelled, else whether history is in it.
pub async fn export(app: &Rc<App>) -> Result<Value, String> {
    let file = match app.test_pick() {
        Some(files) => files.into_iter().next(),
        None => {
            let name = format!("Still-backup-{}.zip", chrono::Local::now().format("%Y-%m-%d"));
            rfd::AsyncFileDialog::new().set_file_name(name).add_filter("Zip", &["zip"]).set_parent(&win::main_parent()).save_file().await.map(|f| f.path().to_path_buf())
        }
    };
    let Some(file) = file else { return Ok(json!(false)) };
    let (snapshot, history) = snapshot(app).await;
    let media = media_dir(app);
    blocking(move || write_zip(&file, &media, &snapshot)).await?;
    Ok(json!({ "history": history }))
}

/// "Import backup": settings, to-dos and alerts become the backup's; its sessions are added to the history here.
/// What was here is saved to `before-import.zip` first, and the import stops if that fails. Answers `false` if cancelled.
pub async fn import(app: &Rc<App>) -> Result<Value, String> {
    let file = match app.test_pick() {
        Some(files) => files.into_iter().next(),
        None => rfd::AsyncFileDialog::new().set_title("Choose a Still backup").add_filter("Zip", &["zip"]).set_parent(&win::main_parent()).pick_file().await.map(|f| f.path().to_path_buf()),
    };
    let Some(file) = file else { return Ok(json!(false)) };
    let media = media_dir(app);
    let loaded = blocking({
        let media = media.clone();
        move || read_backup(&file, &media)
    })
    .await?;
    let (before, _) = snapshot(app).await;
    let known: BTreeSet<String> = before.history.as_array().into_iter().flatten().filter_map(|s| s["id"].as_str().map(String::from)).collect();
    let safety = app.mode.user_data.join("before-import.zip");
    blocking(move || write_zip(&safety, &media, &before)).await.map_err(|e| format!("Your current data could not be saved first, so nothing was imported. {e}"))?;
    let alerts = app.alerts.borrow().clone().ok_or("Alerts are not ready yet. Try again in a moment.")?;
    let sessions: Vec<Value> = loaded.history.into_iter().filter(|s| s["id"].as_str().is_some_and(|id| !known.contains(id))).collect();
    let (alert_count, session_count) = (loaded.alerts.len(), sessions.len());
    app.save_preferences(&loaded.prefs).await?;
    alerts.restore(loaded.alerts, sessions).await?;
    app.tray_label();
    Ok(json!({ "alerts": alert_count, "sessions": session_count }))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SOUND: &str = "0123456789abcdef0123456789abcdef0123.mp3";

    fn temp(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("still-backup-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn zip_of(path: &Path, entries: &[(&str, &[u8])]) {
        let mut zip = ZipWriter::new(File::create(path).unwrap());
        for (name, bytes) in entries {
            zip.start_file(*name, SimpleFileOptions::default()).unwrap();
            zip.write_all(bytes).unwrap();
        }
        zip.finish().unwrap();
    }

    fn alert() -> Value {
        json!({ "title": "Write", "note": "", "date": "2026-09-23", "time": "09:00", "repeat": "daily", "lengthMode": "duration", "durationMinutes": 50, "endTime": "10:00", "style": "card", "blockMode": "none", "apps": [], "unlockDelayMinutes": 5, "sound": "custom", "volume": 65, "enabled": true, "soundFile": { "file": SOUND, "name": "ding.mp3" } })
    }

    #[test]
    fn a_backup_round_trips_and_a_hand_made_zip_cannot_write_elsewhere() {
        let (from, to) = (temp("from"), temp("to"));
        std::fs::create_dir_all(from.join("alert-media")).unwrap();
        std::fs::write(from.join("alert-media").join(SOUND), b"ding").unwrap();
        let session = json!({ "id": "a1", "intention": "Read", "apps": [], "startedAt": 1000, "endsAt": 2000, "finishedAt": 2000, "outcome": "completed" });
        let alarm = json!({ "id": "alarm-x-1", "alarm": true, "intention": "Stretch", "apps": [], "startedAt": 3000, "endsAt": 4000, "finishedAt": 4000, "outcome": "completed" });
        let snapshot = Snapshot { prefs: json!({ "todos": [{ "text": "buy milk", "type": "checkbox", "done": false }] }), alerts: json!([alert()]), history: json!([session, alarm, { "id": "", "startedAt": 1 }]) };
        write_zip(&from.join("backup.zip"), &from.join("alert-media"), &snapshot).unwrap();

        let loaded = read_backup(&from.join("backup.zip"), &to.join("alert-media")).unwrap();
        assert_eq!(loaded.prefs["todos"][0]["text"], "buy milk");
        assert_eq!(loaded.alerts.len(), 1);
        assert_eq!(loaded.history.len(), 2, "the record without an id is dropped");
        assert_eq!((loaded.history[0]["intention"].as_str(), loaded.history[1]["alarm"].as_bool()), (Some("Read"), Some(true)));
        assert_eq!(std::fs::read(to.join("alert-media").join(SOUND)).unwrap(), b"ding");

        // Not a Still backup, a newer format, and entries that try to leave alert-media.
        let manifest = br#"{"app":"Still","format":1}"#;
        let alerts = serde_json::to_vec(&json!([alert()])).unwrap();
        let hostile = to.join("hostile.zip");
        zip_of(&hostile, &[("manifest.json", manifest), ("preferences.json", b"{}"), ("alerts.json", &alerts), ("alert-media/../evil.txt", b"x"), ("../evil2.txt", b"x"), ("alert-media/other.mp3", b"x")]);
        let media = to.join("hostile-media");
        read_backup(&hostile, &media).unwrap();
        assert!(!to.join("evil.txt").exists() && !to.join("hostile-media").join("evil.txt").exists() && !to.parent().unwrap().join("evil2.txt").exists());
        assert_eq!(std::fs::read_dir(&media).unwrap().count(), 0, "only files the alerts name are taken, and this zip has none of them");
        zip_of(&to.join("plain.zip"), &[("preferences.json", b"{}")]);
        assert_eq!(read_backup(&to.join("plain.zip"), &media).err().as_deref(), Some(NOT_A_BACKUP));
        zip_of(&to.join("newer.zip"), &[("manifest.json", br#"{"app":"Still","format":99}"#), ("preferences.json", b"{}")]);
        assert!(read_backup(&to.join("newer.zip"), &media).err().unwrap().contains("newer Still"));
        std::fs::write(to.join("notzip.zip"), b"hello").unwrap();
        assert_eq!(read_backup(&to.join("notzip.zip"), &media).err().as_deref(), Some(NOT_A_BACKUP));
        for dir in [from, to] {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}
