//! Port of `native/WindowsCompatibility.cs`: shared by Setup and Guard.

/// Returns why this Windows cannot run Still protection, or `None` when it can.
pub fn problem(build: i32, revision: i32, framework: i32, is_64_bit: bool, installation_type: &str) -> Option<&'static str> {
    if !is_64_bit {
        return Some("Still requires 64-bit Windows on an Intel or AMD PC. 32-bit Windows is not supported.");
    }
    if installation_type != "Client" || build < 19041 {
        return Some("Still requires Windows 10 version 2004 or later, or Windows 11. Update Windows before installing Still.");
    }
    // KB5024351: cumulative updates that removed AppLocker edition restrictions.
    if (build < 22000 && revision < 2193) || (build == 22000 && revision < 1165) || (build == 22621 && revision < 608) {
        return Some("Install the latest Windows cumulative updates before installing Still. This Windows build lacks the AppLocker updates required for reliable app blocking (KB5024351).");
    }
    if framework < 528040 {
        return Some("Still requires .NET Framework 4.8 or later. Install it through Windows Update, then run setup again.");
    }
    None
}

#[cfg(windows)]
pub fn ensure() -> Result<(), String> {
    use winreg::{RegKey, enums::HKEY_LOCAL_MACHINE};
    let machine = RegKey::predef(HKEY_LOCAL_MACHINE);
    let windows = machine.open_subkey(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion").map_err(|e| e.to_string())?;
    let framework = machine.open_subkey(r"SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full").ok();
    let build = windows.get_value::<String, _>("CurrentBuildNumber").ok().and_then(|s| s.parse().ok()).unwrap_or(0);
    let release = framework.and_then(|k| k.get_value::<u32, _>("Release").ok()).unwrap_or(0) as i32;
    let installation = windows.get_value::<String, _>("InstallationType").unwrap_or_default();
    let is_64 = std::env::var("PROCESSOR_ARCHITECTURE").map(|a| a != "x86").unwrap_or(true) || std::env::var_os("PROCESSOR_ARCHITEW6432").is_some();
    if let Some(message) = problem(build, windows.get_value::<u32, _>("UBR").unwrap_or(0) as i32, release, is_64, &installation) {
        return Err(message.to_string());
    }
    let system = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
    if !std::path::Path::new(&system).join(r"System32\WindowsPowerShell\v1.0\powershell.exe").exists() {
        return Err("Windows PowerShell 5.1 is missing. Restore the Windows PowerShell component before installing Still.".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_update_boundaries_net_architecture_and_client_os() {
        for build in [19041, 19042, 19043, 19044, 19045] {
            assert!(problem(build, 2193, 528040, true, "Client").is_none(), "Updated Windows 10 {build}");
            assert!(problem(build, 2192, 528040, true, "Client").is_some(), "Unpatched Windows 10 {build}");
        }
        for (build, revision) in [(22000, 1165), (22621, 608), (22631, 0), (26100, 0)] {
            assert!(problem(build, revision, 528040, true, "Client").is_none(), "Updated Windows 11");
        }
        assert!(problem(22000, 1164, 528040, true, "Client").is_some());
        assert!(problem(22621, 607, 528040, true, "Client").is_some());
        assert!(problem(18363, 9999, 528040, true, "Client").is_some());
        assert!(problem(26100, 0, 528039, true, "Client").is_some());
        assert!(problem(26100, 0, 528040, false, "Client").is_some());
        assert!(problem(26100, 0, 528040, true, "Server").is_some());
    }
}
