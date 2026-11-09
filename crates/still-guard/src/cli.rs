//! `Still.Guard.exe --install <sid>`, `--uninstall` and `--recover` (they need an administrator): the port of
//! `Install` and `Uninstall` in `native/Guard.cs`.
use crate::{
    enforce::{WebsitePolicy, protect_directory, run_policy},
    guard::{SERVICE_NAME, atomic_write},
};
use std::{
    ffi::OsString,
    path::PathBuf,
    time::{Duration, Instant},
};
use still_core::session::{GuardState, now_ms};
use windows_service::{
    service::{Service, ServiceAccess, ServiceAction, ServiceActionType, ServiceErrorControl, ServiceFailureActions, ServiceFailureResetPeriod, ServiceInfo, ServiceStartType, ServiceState, ServiceType},
    service_manager::{ServiceManager, ServiceManagerAccess},
};

pub fn install_dir() -> PathBuf {
    PathBuf::from(std::env::var("ProgramFiles").unwrap_or_else(|_| "C:\\Program Files".into())).join("Still Guard")
}

pub fn data_dir() -> PathBuf {
    PathBuf::from(std::env::var("ProgramData").unwrap_or_else(|_| "C:\\ProgramData".into())).join("Still")
}

/// windows-service shows every Windows failure as "IO error in winapi call"; show the Windows error itself.
fn os(error: windows_service::Error) -> String {
    match error {
        windows_service::Error::Winapi(e) => e.to_string(),
        e => e.to_string(),
    }
}

fn manager() -> Result<ServiceManager, String> {
    ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT | ServiceManagerAccess::CREATE_SERVICE).map_err(os)
}

fn service_info() -> ServiceInfo {
    ServiceInfo {
        name: OsString::from(SERVICE_NAME),
        display_name: OsString::from("Still Focus Guard"),
        service_type: ServiceType::OWN_PROCESS,
        start_type: ServiceStartType::AutoStart,
        error_control: ServiceErrorControl::Normal,
        // Bare path: windows-service quotes a path with spaces itself. 2.0.0 quoted it here as well, which made the
        // image path `"\"C:\…\Still.Guard.exe\""`; Windows reads that as the folder `\` and fails with "Access is denied".
        executable_path: install_dir().join("Still.Guard.exe"),
        launch_arguments: vec![],
        dependencies: vec![],
        account_name: None,
        account_password: None,
    }
}

fn open(manager: &ServiceManager) -> Option<Service> {
    manager.open_service(SERVICE_NAME, ServiceAccess::QUERY_STATUS | ServiceAccess::START | ServiceAccess::STOP | ServiceAccess::DELETE | ServiceAccess::CHANGE_CONFIG).ok()
}

fn stop(service: &Service) -> Result<(), String> {
    if service.query_status().map_err(os)?.current_state != ServiceState::Stopped {
        let _ = service.stop();
    }
    let deadline = Instant::now() + Duration::from_secs(30);
    while service.query_status().map_err(os)?.current_state != ServiceState::Stopped {
        if Instant::now() > deadline {
            return Err("The Windows guard did not stop in time. Try again.".into());
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    Ok(())
}

fn valid_sid(sid: &str) -> bool {
    sid.strip_prefix("S-1-").is_some_and(|rest| !rest.is_empty() && !rest.starts_with('-') && !rest.ends_with('-') && !rest.contains("--") && rest.chars().all(|c| c.is_ascii_digit() || c == '-'))
}

fn read_state() -> Option<GuardState> {
    serde_json::from_str(&std::fs::read_to_string(data_dir().join("state.json")).ok()?).ok()
}

fn trim_history(state: &mut GuardState) {
    state.history.truncate(500);
    while state.history.len() > 1 && serde_json::to_string(state).map_or(0, |s| s.len()) > 700_000 {
        state.history.pop();
    }
}

pub fn install(sid: &str) -> Result<(), String> {
    if !valid_sid(sid) {
        return Err("Unknown guard command.".into());
    }
    still_core::compat::ensure()?;
    let (install, data) = (install_dir(), data_dir());
    let source = std::env::current_exe().map_err(|e| e.to_string())?.parent().map(PathBuf::from).unwrap_or_default();
    // Check the new policy before stopping/replacing an existing working service.
    run_policy(&source, &data, "check", None)?;
    let manager = manager()?;
    let existing = open(&manager);
    if let Some(service) = &existing {
        if std::fs::read_to_string(data.join("owner.txt")).map(|o| o.trim() != sid).unwrap_or(true) {
            return Err("Still Guard is registered to another Windows account.".into());
        }
        if read_state().is_some_and(|s| s.session.is_some()) {
            return Err("Finish the active focus session before updating protection.".into());
        }
        stop(service)?;
    }
    protect_directory(&install, sid)?;
    protect_directory(&data, sid)?;
    // Browsers keep Still.Guard.exe running as their native messaging host, which locks it.
    // A running exe can still be renamed, so move old copies aside and clean them up later.
    if let Ok(entries) = std::fs::read_dir(&install) {
        for entry in entries.flatten().filter(|e| e.path().extension().is_some_and(|x| x == "old")) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
    for file in ["Still.Guard.exe", "policy.ps1"] {
        let (from, to) = (source.join(file), install.join(file));
        if from.to_string_lossy().eq_ignore_ascii_case(&to.to_string_lossy()) {
            continue;
        }
        if to.exists() {
            std::fs::rename(&to, format!("{}.{}.old", to.display(), uuid::Uuid::new_v4().simple())).map_err(|e| e.to_string())?;
        }
        std::fs::copy(&from, &to).map_err(|e| e.to_string())?;
    }
    std::fs::write(data.join("owner.txt"), sid).map_err(|e| e.to_string())?;
    let service = match existing {
        // Rewriting the config of an existing service also repairs the broken image path 2.0.0 registered.
        Some(service) => service.change_config(&service_info()).map(|()| service).map_err(os)?,
        None => manager
            .create_service(&service_info(), ServiceAccess::QUERY_STATUS | ServiceAccess::START | ServiceAccess::STOP | ServiceAccess::DELETE | ServiceAccess::CHANGE_CONFIG)
            .map_err(os)?,
    };
    service.set_description("Enforces Still focus sessions and safely releases expired application blocks.").map_err(os)?;
    let restart = |seconds| ServiceAction { action_type: ServiceActionType::Restart, delay: Duration::from_secs(seconds) };
    service
        .update_failure_actions(ServiceFailureActions { reset_period: ServiceFailureResetPeriod::After(Duration::from_secs(86_400)), reboot_msg: None, command: None, actions: Some(vec![restart(5), restart(10), restart(30)]) })
        .map_err(os)?;
    service.start::<OsString>(&[]).map_err(|e| format!("Windows could not start Still Guard: {}", os(e)))
}

pub fn uninstall(recovery: bool) -> Result<(), String> {
    let data = data_dir();
    if !recovery && read_state().and_then(|s| s.session).is_some_and(|s| !s.expired(now_ms())) {
        return Err("Finish the active focus session before removing protection.".into());
    }
    let manager = manager()?;
    // Device-policy cleanup must run in the SYSTEM service, including administrator recovery.
    if data.join("csp-active").exists() {
        let request = data.join("recover-request");
        std::fs::write(&request, "Release Still policy").map_err(|e| e.to_string())?;
        if let Some(service) = open(&manager) {
            if service.query_status().map_err(os)?.current_state == ServiceState::Stopped {
                service.start::<OsString>(&[]).map_err(os)?;
            }
        }
        let deadline = Instant::now() + Duration::from_secs(60);
        while request.exists() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(250));
        }
        if request.exists() {
            return Err("Windows protection could not release its rules. The service will keep retrying.".into());
        }
    }
    let service = open(&manager);
    if let Some(service) = &service {
        stop(service)?;
    }
    let policy = run_policy(&install_dir(), &data, "clear", None);
    let websites = WebsitePolicy::local_machine(&data).clear();
    policy.and(websites)?;
    if let Some(mut saved) = read_state() {
        if let Some(mut session) = saved.session.take() {
            session.outcome = Some("recovered".into());
            session.finished_at = now_ms();
            saved.history.insert(0, session);
            trim_history(&mut saved);
            atomic_write(&data.join("state.json"), &serde_json::to_string(&saved).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        }
    }
    if let Some(service) = service {
        service.delete().map_err(os)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{service_info, valid_sid};

    #[test]
    fn service_path_is_left_unquoted_for_windows_service() {
        // windows-service quotes it; quoting it here too gives an image path Windows can't run (see service_info).
        assert!(!service_info().executable_path.to_string_lossy().contains('"'));
    }

    #[test]
    fn only_real_sids_are_accepted() {
        assert!(valid_sid("S-1-5-21-1004336348-1177238915-682003330-512"));
        for bad in ["", "S-1-", "S-1--5", "S-1-5-", "S-1-5-x", "S-2-5-21", "'; calc; '", "S-1-5-21 -1"] {
            assert!(!valid_sid(bad), "{bad}");
        }
    }
}
