//! The Windows service: loads the owner, starts the guard and serves its named pipe.
use crate::{
    cli::{data_dir, install_dir},
    enforce::WindowsEnforcer,
    guard::{Guard, PIPE_NAME, Paths, Request, read_request},
};
use serde_json::json;
use std::{
    ffi::{OsString, c_void},
    sync::{Arc, atomic::Ordering, mpsc},
    time::Duration,
};
use tokio::{io::AsyncWriteExt, net::windows::named_pipe::{NamedPipeServer, ServerOptions}, time::timeout};
use windows::{
    Win32::{
        Foundation::FALSE,
        Security::{
            SECURITY_ATTRIBUTES,
            Authorization::{ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1},
        },
    },
    core::HSTRING,
};
use windows_service::{
    define_windows_service,
    service::{ServiceControl, ServiceControlAccept, ServiceExitCode, ServiceState, ServiceStatus, ServiceType},
    service_control_handler::{self, ServiceControlHandlerResult},
    service_dispatcher,
};

define_windows_service!(ffi_service_main, service_main);

pub fn run() -> i32 {
    match service_dispatcher::start(crate::guard::SERVICE_NAME, ffi_service_main) {
        Ok(()) => 0,
        Err(_) => 1,
    }
}

fn service_main(_arguments: Vec<OsString>) {
    let _ = run_service();
}

fn status(state: ServiceState, accept: ServiceControlAccept, exit: u32) -> ServiceStatus {
    ServiceStatus { service_type: ServiceType::OWN_PROCESS, current_state: state, controls_accepted: accept, exit_code: ServiceExitCode::Win32(exit), checkpoint: 0, wait_hint: Duration::from_secs(10), process_id: None }
}

fn run_service() -> windows_service::Result<()> {
    let (stop_sender, stop_receiver) = mpsc::channel::<()>();
    let handle = service_control_handler::register(crate::guard::SERVICE_NAME, move |control| match control {
        ServiceControl::Stop => {
            let _ = stop_sender.send(());
            ServiceControlHandlerResult::NoError
        }
        ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
        _ => ServiceControlHandlerResult::NotImplemented,
    })?;
    handle.set_service_status(status(ServiceState::StartPending, ServiceControlAccept::empty(), 0))?;
    let data = data_dir();
    let owner = match std::fs::read_to_string(data.join("owner.txt")) {
        Ok(owner) => owner.trim().to_string(),
        Err(_) => return handle.set_service_status(status(ServiceState::Stopped, ServiceControlAccept::empty(), 1)),
    };
    let guard = Arc::new(Guard::new(Paths::new(data.clone()), owner.clone(), Box::new(WindowsEnforcer::new(install_dir(), data))));
    handle.set_service_status(status(ServiceState::Running, ServiceControlAccept::STOP, 0))?;
    // Start-up work, the one-second release timer and the pipe all run off the service thread.
    {
        let guard = guard.clone();
        std::thread::spawn(move || {
            guard.init();
            while !guard.stopping.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_secs(1));
                guard.tick();
            }
        });
    }
    let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().map_err(|_| windows_service::Error::LaunchArgumentsNotSupported)?;
    runtime.spawn(listen(guard.clone(), owner));
    let _ = stop_receiver.recv();
    handle.set_service_status(status(ServiceState::StopPending, ServiceControlAccept::empty(), 0))?;
    guard.stopping.store(true, Ordering::SeqCst);
    runtime.shutdown_background();
    handle.set_service_status(status(ServiceState::Stopped, ServiceControlAccept::empty(), 0))
}

/// Only the owner, SYSTEM and Administrators may talk to the guard, and never over the network.
/// Returns the security descriptor (as an address, so it can live across awaits).
fn pipe_descriptor(owner: &str) -> Option<usize> {
    let sddl = format!("D:(D;;FA;;;NU)(A;;0x12019f;;;{owner})(A;;0x12019f;;;SY)(A;;0x12019f;;;BA)");
    let mut descriptor = windows::Win32::Security::PSECURITY_DESCRIPTOR::default();
    unsafe { ConvertStringSecurityDescriptorToSecurityDescriptorW(&HSTRING::from(sddl), SDDL_REVISION_1, &mut descriptor, None).ok()? };
    Some(descriptor.0 as usize)
}

async fn listen(guard: Arc<Guard>, owner: String) {
    let Some(descriptor) = pipe_descriptor(&owner) else { return };
    // Clients retry while the pipe is absent, so wait until the saved session has been loaded.
    while !guard.ready.load(Ordering::SeqCst) && !guard.stopping.load(Ordering::SeqCst) {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let mut first = true;
    while !guard.stopping.load(Ordering::SeqCst) {
        let created = {
            let mut attributes = SECURITY_ATTRIBUTES { nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: descriptor as *mut c_void, bInheritHandle: FALSE };
            unsafe { ServerOptions::new().first_pipe_instance(first).max_instances(8).reject_remote_clients(true).create_with_security_attributes_raw(PIPE_NAME, &mut attributes as *mut _ as *mut c_void) }
        };
        let server = match created {
            Ok(server) => server,
            Err(_) => {
                tokio::time::sleep(Duration::from_millis(500)).await;
                continue;
            }
        };
        first = false;
        if server.connect().await.is_ok() {
            tokio::spawn(serve(guard.clone(), server));
        }
    }
}

async fn serve(guard: Arc<Guard>, mut pipe: NamedPipeServer) {
    let Some(line) = read_request(&mut pipe).await else { return };
    let Ok(incoming) = serde_json::from_str::<Option<Request>>(&line) else { return };
    // Browser acknowledgements must be received while a start holds the session lock.
    if let Some(request) = incoming.as_ref().filter(|r| r.command.as_deref() == Some("websiteReady")) {
        let accepted = guard.website_ready(request.id.as_deref());
        let _ = timeout(Duration::from_secs(5), pipe.write_all(if accepted { b"{\"ok\":true}\n" } else { b"{\"ok\":false}\n" })).await;
        return;
    }
    let response = tokio::task::spawn_blocking(move || match incoming {
        Some(request) => guard.handle_request(&request),
        None => json!({ "ok": false, "error": "Invalid request" }),
    })
    .await;
    if let Ok(response) = response {
        let _ = timeout(Duration::from_secs(5), pipe.write_all(format!("{response}\n").as_bytes())).await;
    }
}
