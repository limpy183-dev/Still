//! The browser's native-messaging host (`Websites.BrowserHost` in `native/Websites.cs`): it streams the session's website
//! rules to the companion extension and relays the extension's "ready" acknowledgement to the guard.
//! It sleeps until the guard writes its state, so there is no URL inspection and no polling loop.
use crate::guard::PIPE_NAME;
use serde_json::{Value, json};
use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, atomic::{AtomicBool, Ordering}},
    time::{Duration, Instant},
};
use still_core::{session::GuardState, websites::domain_of};
use windows::{
    Win32::{
        Foundation::{CloseHandle, HANDLE},
        Storage::FileSystem::{FILE_NOTIFY_CHANGE_FILE_NAME, FILE_NOTIFY_CHANGE_LAST_WRITE, FILE_NOTIFY_CHANGE_SIZE, FindFirstChangeNotificationW, FindNextChangeNotification},
        System::Threading::{CreateEventW, INFINITE, SetEvent, WaitForMultipleObjects},
    },
    core::HSTRING,
};

pub fn default_paths() -> (PathBuf, PathBuf) {
    let program_data = PathBuf::from(std::env::var("ProgramData").unwrap_or_else(|_| "C:\\ProgramData".into()));
    let app_data = PathBuf::from(std::env::var("APPDATA").unwrap_or_default());
    (program_data.join("Still").join("state.json"), app_data.join("still-focus").join("preferences.json"))
}

/// Daily limits and bedtime come from the user's own Still preferences; the companion validates them.
fn limits(prefs: &Path) -> Value {
    std::fs::read_to_string(prefs).ok().and_then(|text| serde_json::from_str::<Value>(&text).ok()).and_then(|v| v.get("websiteLimits").cloned()).unwrap_or(Value::Null)
}

/// What the extension needs to know: the session's websites, block screen and end time, plus the limits.
fn snapshot(state: &GuardState, prefs: &Path) -> Option<Value> {
    let session = state.session.as_ref();
    let websites: Vec<String> = session.map(|s| s.apps.iter().filter(|a| a.is_website()).map(domain_of).collect::<Result<_, _>>()).transpose().ok()?.unwrap_or_default();
    let screen = session.and_then(|s| s.block_screen.as_ref()).map(|b| json!({ "mode": b.mode, "title": b.title, "text": b.text, "image": b.image, "redirect": b.redirect }));
    Some(json!({ "sessionId": session.map(|s| s.id.clone()), "websites": websites, "screen": screen, "endsAt": session.map_or(0, |s| s.ends_at), "limits": limits(prefs) }))
}

/// Tells the guard that the browser applied the rules for session `id` (connecting for up to 3 s, replying within 5 s).
fn send_ready(id: &str) {
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut pipe = loop {
        match std::fs::OpenOptions::new().read(true).write(true).open(PIPE_NAME) {
            Ok(pipe) => break pipe,
            Err(_) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            Err(_) => return, // A restarted guard sends a fresh snapshot on its next save.
        }
    };
    if pipe.write_all(format!("{}\n", json!({ "command": "websiteReady", "id": id })).as_bytes()).and_then(|()| pipe.flush()).is_err() {
        return;
    }
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut reply = [0u8; 64];
        let _ = sender.send(pipe.read(&mut reply));
    });
    let _ = receiver.recv_timeout(Duration::from_secs(5));
}

fn watch(file: &Path) -> Option<isize> {
    let dir = file.parent()?;
    std::fs::create_dir_all(dir).ok()?;
    unsafe { FindFirstChangeNotificationW(&HSTRING::from(dir.as_os_str()), false, FILE_NOTIFY_CHANGE_LAST_WRITE | FILE_NOTIFY_CHANGE_FILE_NAME | FILE_NOTIFY_CHANGE_SIZE).ok().map(|h| h.0 as isize) }
}

pub fn run(state_path: &Path, prefs_path: &Path) -> i32 {
    let closed = Arc::new(AtomicBool::new(false));
    let wake = unsafe { CreateEventW(None, true, false, None) }.map(|h| h.0 as isize).unwrap_or(0);
    let signal = move || unsafe {
        let _ = SetEvent(HANDLE(wake as _));
    };
    // The browser closing stdin ends the host, even while no state changes occur.
    {
        let closed = closed.clone();
        std::thread::spawn(move || {
            let mut input = std::io::stdin().lock();
            let read_exact = |input: &mut std::io::StdinLock, length: usize| -> Option<Vec<u8>> {
                let mut bytes = vec![0u8; length];
                input.read_exact(&mut bytes).ok().map(|()| bytes)
            };
            while let Some(header) = read_exact(&mut input, 4) {
                let length = i32::from_le_bytes([header[0], header[1], header[2], header[3]]);
                if length <= 0 || length > 4096 {
                    break;
                }
                let Some(body) = read_exact(&mut input, length as usize) else { break };
                if let Some(id) = serde_json::from_slice::<Value>(&body).ok().and_then(|m| m.get("ready").and_then(Value::as_str).filter(|id| id.chars().count() <= 100).map(String::from)) {
                    send_ready(&id);
                }
            }
            closed.store(true, Ordering::SeqCst);
            signal();
        });
    }
    let watchers: Vec<isize> = [state_path, prefs_path].iter().filter_map(|f| watch(f)).collect();
    let mut handles: Vec<HANDLE> = vec![HANDLE(wake as _)];
    handles.extend(watchers.iter().map(|h| HANDLE(*h as _)));
    let mut output = std::io::stdout();
    let (mut previous, mut first) = (None::<String>, true);
    while !closed.load(Ordering::SeqCst) {
        if !first {
            unsafe {
                WaitForMultipleObjects(&handles, false, INFINITE);
                for watcher in &watchers {
                    let _ = FindNextChangeNotification(HANDLE(*watcher as _));
                }
            }
            if closed.load(Ordering::SeqCst) {
                break;
            }
        }
        first = false;
        let mut state = None;
        for _ in 0..5 {
            match std::fs::read_to_string(state_path) {
                Ok(text) => {
                    state = serde_json::from_str::<GuardState>(&text).ok();
                    break;
                }
                Err(_) => std::thread::sleep(Duration::from_millis(50)),
            }
        }
        // Never clear blocks because a file was unreadable or corrupt: another save will retry.
        let Some(data) = state.and_then(|s| snapshot(&s, prefs_path)).map(|d| d.to_string()) else { continue };
        if previous.as_deref() == Some(data.as_str()) {
            continue;
        }
        let bytes = data.as_bytes();
        if output.write_all(&(bytes.len() as u32).to_le_bytes()).and_then(|()| output.write_all(bytes)).and_then(|()| output.flush()).is_err() {
            break;
        }
        previous = Some(data);
    }
    unsafe {
        for handle in handles {
            let _ = CloseHandle(handle);
        }
    }
    0
}
