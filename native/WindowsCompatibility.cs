using System;
using System.IO;
using Microsoft.Win32;

namespace Still {
    // Shared by Setup and Guard; use the registry rather than manifest-dependent OSVersion.
    public static class WindowsCompatibility {
        public static string Problem(int build, int revision, int framework, bool is64Bit, string installationType) {
            if (!is64Bit) return "Still requires 64-bit Windows on an Intel or AMD PC. 32-bit Windows is not supported.";
            if (installationType != "Client" || build < 19041)
                return "Still requires Windows 10 version 2004 or later, or Windows 11. Update Windows before installing Still.";
            // KB5024351: cumulative updates that removed AppLocker edition restrictions.
            if ((build < 22000 && revision < 2193) || (build == 22000 && revision < 1165) || (build == 22621 && revision < 608))
                return "Install the latest Windows cumulative updates before installing Still. This Windows build lacks the AppLocker updates required for reliable app blocking (KB5024351).";
            if (framework < 528040) return "Still requires .NET Framework 4.8 or later. Install it through Windows Update, then run setup again.";
            return null;
        }

        public static void Ensure() {
            using (var windows = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Windows NT\CurrentVersion"))
            using (var framework = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full")) {
                var problem = Problem(Convert.ToInt32(windows.GetValue("CurrentBuildNumber", "0")),
                    Convert.ToInt32(windows.GetValue("UBR", 0)), Convert.ToInt32(framework == null ? 0 : framework.GetValue("Release", 0)),
                    Environment.Is64BitOperatingSystem, windows.GetValue("InstallationType", "") as string);
                if (problem != null) throw new Exception(problem);
            }
            if (!File.Exists(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), @"WindowsPowerShell\v1.0\powershell.exe")))
                throw new Exception("Windows PowerShell 5.1 is missing. Restore the Windows PowerShell component before installing Still.");
        }
    }
}
