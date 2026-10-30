// Still Guard: the SYSTEM service that enforces focus sessions, the install/uninstall commands that need an
// administrator, and the browser's native-messaging host. The Rust port of native/Guard.cs.
#![windows_subsystem = "windows"]

mod cli;
mod enforce;
mod guard;
mod host;
mod service;

use windows::{
    Win32::UI::{
        Shell::IsUserAnAdmin,
        WindowsAndMessaging::{MB_ICONERROR, MB_OK, MessageBoxW},
    },
    core::HSTRING,
};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    // Chrome and Edge start the host with the extension's origin as its first argument.
    if args.first().is_some_and(|a| a.starts_with("chrome-extension://")) {
        let (state, prefs) = host::default_paths();
        std::process::exit(host::run(&state, &prefs));
    }
    if args.is_empty() {
        std::process::exit(service::run());
    }
    let result = if !unsafe { IsUserAnAdmin() }.as_bool() {
        Err("Administrator permission is required to install or remove the Windows guard.".to_string())
    } else {
        match (args[0].as_str(), args.len()) {
            ("--install", 2) => cli::install(&args[1]),
            ("--uninstall", _) => cli::uninstall(false),
            ("--recover", _) => cli::uninstall(true),
            _ => Err("Unknown guard command.".to_string()),
        }
    };
    if let Err(message) = result {
        unsafe {
            MessageBoxW(None, &HSTRING::from(message), &HSTRING::from("Still · Windows protection"), MB_OK | MB_ICONERROR);
        }
        std::process::exit(1);
    }
}
