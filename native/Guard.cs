using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Linq;
using System.Security.AccessControl;
using System.Security.Principal;
using System.ServiceProcess;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace Still {
    public class Request {
        public BlockScreen blockScreen { get; set; }
        public string command { get; set; }
        public string historyRevision { get; set; }
        public string id { get; set; }
        public string action { get; set; }
        public int durationMinutes { get; set; }
        public long scheduledEndsAt { get; set; }
        public int unlockDelayMinutes { get; set; }
        public string intention { get; set; }
        public List<TargetApp> apps { get; set; }
    }
    public class Guard : ServiceBase {
        const string ServiceId = "StillFocusGuard";
        const string PipeName = "Still.Focus.Guard.v1";
        static readonly string Data = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "Still");
        static readonly string InstallDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Still Guard");
        static readonly string StatePath = Path.Combine(Data, "state.json");
        static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 1024 * 1024 };
        readonly object gate = new object();
        readonly ManualResetEvent websiteReady = new ManualResetEvent(false);
        volatile string websiteAwaitId;
        bool recoveryPending;
        long nextRecoveryAt;
        GuardState state = new GuardState();
        string historyRevision = Guid.NewGuid().ToString();
        string owner;
        System.Threading.Timer timer;
        volatile bool stopping;
        long lastNow;
        Stopwatch clock = Stopwatch.StartNew();
        long origin = FocusSession.Now();
        long Now() { lastNow = Math.Max(lastNow, Math.Max(FocusSession.Now(), origin + clock.ElapsedMilliseconds)); return lastNow; }

        [STAThread]
        static int Main(string[] args) {
            if (args.Length > 0 && args[0].StartsWith("chrome-extension://", StringComparison.Ordinal)) { try { return Websites.BrowserHost(); } catch { return 1; } }
            if (args.Length == 0) { ServiceBase.Run(new Guard()); return 0; }
            try {
                if (!new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator))
                    throw new Exception("Administrator permission is required to install or remove the Windows guard.");
                if (args[0] == "--install" && args.Length == 2) Install(args[1]);
                else if (args[0] == "--uninstall") Uninstall(false);
                else if (args[0] == "--recover") Uninstall(true);
                else throw new Exception("Unknown guard command.");
                return 0;
            } catch (Exception ex) {
                MessageBox.Show(ex.Message, "Still · Windows protection", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }
        }
        public Guard() { ServiceName = ServiceId; CanStop = true; AutoLog = true; }
        static void ProtectDirectory(string path, string readSid) {
            Directory.CreateDirectory(path);
            if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0) throw new Exception("The guard directory must not be a symbolic link or junction: " + path);
            var acl = new DirectorySecurity();
            acl.SetAccessRuleProtection(true, false);
            acl.SetOwner(new SecurityIdentifier("S-1-5-32-544"));
            var inheritance = InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit;
            foreach (var sid in new string[] { "S-1-5-18", "S-1-5-32-544" })
                acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid), FileSystemRights.FullControl, inheritance, PropagationFlags.None, AccessControlType.Allow));
            acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(readSid), FileSystemRights.ReadAndExecute, inheritance, PropagationFlags.None, AccessControlType.Allow));
            Directory.SetAccessControl(path, acl);
            foreach (var file in Directory.GetFiles(path)) {
                if ((File.GetAttributes(file) & FileAttributes.ReparsePoint) != 0) throw new Exception("Unexpected symbolic link in the guard directory.");
                var fileAcl = new FileSecurity();
                fileAcl.SetAccessRuleProtection(true, false);
                fileAcl.SetOwner(new SecurityIdentifier("S-1-5-32-544"));
                foreach (var sid in new string[] { "S-1-5-18", "S-1-5-32-544" })
                    fileAcl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid), FileSystemRights.FullControl, AccessControlType.Allow));
                fileAcl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(readSid), FileSystemRights.ReadAndExecute, AccessControlType.Allow));
                File.SetAccessControl(file, fileAcl);
            }
        }
        static void Install(string sid) {
            new SecurityIdentifier(sid);
            bool installed = ServiceController.GetServices().Any(s => s.ServiceName == ServiceId);
            if (installed)
            {
                if (!File.Exists(Path.Combine(Data, "owner.txt")) || File.ReadAllText(Path.Combine(Data, "owner.txt")).Trim() != sid)
                    throw new Exception("Still Guard is registered to another Windows account.");
                if (File.Exists(StatePath) && Json.Deserialize<GuardState>(File.ReadAllText(StatePath)).session != null)
                    throw new Exception("Finish the active focus session before updating protection.");
                using (var service = new ServiceController(ServiceId)) {
                    if (service.Status != ServiceControllerStatus.Stopped) service.Stop();
                    service.WaitForStatus(ServiceControllerStatus.Stopped, TimeSpan.FromSeconds(30));
                }
            }
            ProtectDirectory(InstallDir, sid);
            ProtectDirectory(Data, sid);
            var source = AppDomain.CurrentDomain.BaseDirectory;
            foreach (var file in new string[] { "Still.Guard.exe", "policy.ps1" }) {
                var destination = Path.Combine(InstallDir, file);
                if (!String.Equals(Path.Combine(source, file), destination, StringComparison.OrdinalIgnoreCase))
                    File.Copy(Path.Combine(source, file), destination, true);
            }
            File.WriteAllText(Path.Combine(Data, "owner.txt"), sid);
            RunPolicy("check", null);
            if (!installed) Run("sc.exe", "create " + ServiceId + " binPath= \"\\\"" + Path.Combine(InstallDir, "Still.Guard.exe") + "\\\"\" start= auto DisplayName= \"Still Focus Guard\"");
            Run("sc.exe", "description " + ServiceId + " \"Enforces Still focus sessions and safely releases expired application blocks.\"");
            Run("sc.exe", "failure " + ServiceId + " reset= 86400 actions= restart/5000/restart/10000/restart/30000");
            Run("sc.exe", "start " + ServiceId);
        }
        static void Uninstall(bool recovery) {
            if (!recovery && File.Exists(StatePath)) {
                var saved = Json.Deserialize<GuardState>(File.ReadAllText(StatePath));
                if (saved.session != null && !saved.session.Expired(FocusSession.Now()))
                    throw new Exception("Finish the active focus session before removing protection.");
            }
            // Device-policy cleanup must run in the SYSTEM service, including administrator recovery.
            if (File.Exists(Path.Combine(Data, "csp-active"))) {
                string recoveryRequest = Path.Combine(Data, "recover-request");
                File.WriteAllText(recoveryRequest, "Release Still policy");
                using (var service = new ServiceController(ServiceId)) {
                    if (service.Status == ServiceControllerStatus.Stopped) service.Start();
                }
                var deadline = DateTime.UtcNow.AddSeconds(60);
                while (File.Exists(recoveryRequest) && DateTime.UtcNow < deadline) Thread.Sleep(250);
                if (File.Exists(recoveryRequest)) throw new Exception("Windows protection could not release its rules. The service will keep retrying.");
            }
            using (var svc = new ServiceController(ServiceId)) {
                try { if (svc.Status != ServiceControllerStatus.Stopped) { svc.Stop(); svc.WaitForStatus(ServiceControllerStatus.Stopped, TimeSpan.FromSeconds(30)); } }
                catch (InvalidOperationException) { }
            }
            ClearProtection();
            if (File.Exists(StatePath)) {
                var saved = Json.Deserialize<GuardState>(File.ReadAllText(StatePath));
                if (saved.session != null) {
                    saved.session.outcome = "recovered"; saved.session.finishedAt = FocusSession.Now();
                    saved.history.Insert(0, saved.session); saved.session = null;
                    TrimHistory(saved);
                    AtomicWrite(StatePath, Json.Serialize(saved));
                }
            }
            if (ServiceController.GetServices().Any(s => s.ServiceName == ServiceId)) Run("sc.exe", "delete " + ServiceId);
        }
        static string Run(string file, string args) {
            if (file == "sc.exe") file = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), file);
            var start = new ProcessStartInfo(file, args) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
            using (var process = Process.Start(start)) {
                var output = process.StandardOutput.ReadToEndAsync();
                var error = process.StandardError.ReadToEndAsync();
                if (!process.WaitForExit(90000)) { process.Kill(); throw new Exception("Windows protection timed out. Please try again."); }
                Task.WaitAll(output, error);
                if (process.ExitCode != 0) throw new Exception((error.Result + " " + output.Result).Trim());
                return output.Result;
            }
        }
        static void RunPolicy(string action, object payload) {
            string script = Path.Combine(InstallDir, "policy.ps1").Replace("'", "''");
            string encoded = payload == null ? "" : Convert.ToBase64String(Encoding.UTF8.GetBytes(Json.Serialize(payload)));
            string command = "$ErrorActionPreference='Stop'; try { & '" + script + "' -Action '" + action + "' -Payload '" + encoded + "' } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }";
            Run(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), @"WindowsPowerShell\v1.0\powershell.exe"),
                "-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand " + Convert.ToBase64String(Encoding.Unicode.GetBytes(command)));
        }
        static void ClearProtection() { try { RunPolicy("clear", null); } finally { Websites.Clear(); } }
        static void AtomicWrite(string file, string value) {
            var temp = file + ".tmp";
            using (var stream = new FileStream(temp, FileMode.Create, FileAccess.Write, FileShare.None)) {
                var bytes = Encoding.UTF8.GetBytes(value); stream.Write(bytes, 0, bytes.Length); stream.Flush(true);
            }
            if (File.Exists(file)) File.Replace(temp, file, file + ".bak"); else File.Move(temp, file);
        }
        void Save() { AtomicWrite(StatePath, Json.Serialize(state)); }
        static void TrimHistory(GuardState saved) {
            saved.history = saved.history.Take(500).ToList();
            while (saved.history.Count > 1 && Json.Serialize(saved).Length > 700000) saved.history.RemoveAt(saved.history.Count - 1);
        }
        protected override void OnStart(string[] args) {
            owner = File.ReadAllText(Path.Combine(Data, "owner.txt")).Trim();
            ThreadPool.QueueUserWorkItem(delegate {
                lock (gate) {
                    try {
                        if (File.Exists(StatePath)) state = Json.Deserialize<GuardState>(File.ReadAllText(StatePath));
                        if (state == null) throw new Exception("Empty state file");
                        if (state.history == null) state.history = new List<FocusSession>();
                        TrimHistory(state);
                    } catch {
                        state = new GuardState(); state.error = "Session data could not be read.";
                        try { ClearProtection(); state.error += " Orphaned focus rules have been released."; Save(); }
                        catch (Exception ex) { state.error += " Recovery needs attention: " + ex.Message; }
                    }
                    try {
                        if (state.session == null) ClearProtection();
                        else if (state.session.phase != "active") Finish("interrupted");
                        else if (state.session.Expired(Now())) Finish("completed");
                        Save(); // Publish an authoritative initial snapshot to connected browsers.
                    } catch (Exception ex) { state.error = ex.Message; recoveryPending = state.session == null; nextRecoveryAt = Now() + 30000; }
                }
                timer = new System.Threading.Timer(Tick, null, 1000, 1000);
                Listen();
            });
        }
        protected override void OnStop() { stopping = true; if (timer != null) timer.Dispose(); }
        void Listen() {
            var acl = new PipeSecurity();
            acl.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.NetworkSid, null), PipeAccessRights.FullControl, AccessControlType.Deny));
            foreach (var sid in new string[] { owner, "S-1-5-18", "S-1-5-32-544" })
                acl.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(sid), PipeAccessRights.ReadWrite, AccessControlType.Allow));
            while (!stopping) {
                NamedPipeServerStream pipe = null;
                try {
                    pipe = new NamedPipeServerStream(PipeName, PipeDirection.InOut, 8, PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 65536, 65536, acl);
                    pipe.WaitForConnection();
                    var connection = pipe;
                    ThreadPool.QueueUserWorkItem(delegate { Serve(connection); });
                } catch { if (pipe != null) pipe.Dispose(); if (!stopping) Thread.Sleep(500); }
            }
        }
        void Serve(NamedPipeServerStream pipe) {
            using (pipe) {
                try {
                    string input = ReadRequest(pipe);
                    if (input == null) return;
                    var incoming = new JavaScriptSerializer { MaxJsonLength = 262144 }.Deserialize<Request>(input);
                    // Browser acknowledgements must be received while start holds the session lock.
                    if (incoming != null && incoming.command == "websiteReady") {
                        bool accepted = incoming.id != null && incoming.id == websiteAwaitId;
                        if (accepted) websiteReady.Set();
                        var acknowledgement = Encoding.UTF8.GetBytes(accepted ? "{\"ok\":true}\n" : "{\"ok\":false}\n");
                        var sent = pipe.WriteAsync(acknowledgement, 0, acknowledgement.Length); sent.Wait(5000);
                        return;
                    }
                    object response;
                    lock (gate) {
                        try {
                            var request = incoming;
                            if (request == null) throw new Exception("Invalid request");
                            Handle(request);
                            response = StatusResponse(request);
                        } catch (Exception ex) { response = new { ok = false, error = ex.Message }; }
                        var bytes = Encoding.UTF8.GetBytes(Json.Serialize(response) + "\n");
                        var write = pipe.WriteAsync(bytes, 0, bytes.Length); write.Wait(5000);
                    }
                } catch { /* A disconnected UI never changes the guard state. */ }
            }
        }
        static string ReadRequest(Stream stream) {
            var buffer = new byte[1024]; int total = 0;
            while (total < 262144) {
                if (total == buffer.Length) Array.Resize(ref buffer, Math.Min(262144, buffer.Length * 2));
                var read = stream.ReadAsync(buffer, total, buffer.Length - total);
                if (!read.Wait(5000) || read.Result == 0) return null;
                int start = total; total += read.Result;
                int end = Array.IndexOf(buffer, (byte)10, start, read.Result);
                if (end >= 0) return Encoding.UTF8.GetString(buffer, 0, end);
            }
            return null;
        }
        object StatusResponse(Request request) {
            var response = new Dictionary<string, object> {
                { "ok", true }, { "installed", true }, { "scheduledAlerts", true }, { "snoozeAlerts", true }, { "websiteBlocking", true }, { "websiteLimits", true },
                { "session", state.session == null ? null : state.session.Summary() }, { "historyRevision", historyRevision },
                { "error", state.error }, { "now", Now() }
            };
            // A new process has a fresh token, so reconnects cannot reuse stale history.
            if (request.command != "status" || request.historyRevision != historyRevision)
                response["history"] = state.history;
            return response;
        }
        void Tick(object unused) {
            if (!Monitor.TryEnter(gate)) return;
            try {
                if (recoveryPending && state.session == null && Now() >= nextRecoveryAt) {
                    nextRecoveryAt = Now() + 30000;
                    ClearProtection(); state.error = null; Save(); recoveryPending = false;
                }
                string recoveryRequest = Path.Combine(Data, "recover-request");
                if (File.Exists(recoveryRequest)) {
                    if (state.session != null) Finish("recovered"); else ClearProtection();
                    File.Delete(recoveryRequest);
                }
                if (state.session != null && (state.session.Expired(Now()) || state.session.phase == "releasing"))
                    Finish(state.session.phase == "releasing" ? state.session.outcome : "completed");
            } catch (Exception ex) { state.error = "Release needs attention: " + ex.Message; }
            finally { Monitor.Exit(gate); }
        }
        void Finish(string outcome) {
            state.session.phase = "releasing"; state.session.outcome = outcome;
            // A full disk must not prevent an attempt to release expired rules.
            try { Save(); } catch (IOException) { }
            ClearProtection();
            state.session.finishedAt = Now();
            state.session.blockScreen = null; // Artwork belongs to the active session, not every history record.
            state.history.Insert(0, state.session);
            historyRevision = Guid.NewGuid().ToString();
            state.session = null; state.error = null; TrimHistory(state); Save();
            websiteAwaitId = null; websiteReady.Reset();
        }
        void Handle(Request request) {
            if (state.session != null && state.session.Expired(Now())) Finish("completed");
            switch (request.command) {
                case "status": return;
                case "updateHistory":
                    if (request.action != "archive" && request.action != "restore" && request.action != "delete") throw new Exception("Invalid history action.");
                    var record = state.history.FirstOrDefault(s => s.id == request.id);
                    if (record == null) throw new Exception("Saved session not found.");
                    var previousHistory = state.history.ToList();
                    bool wasArchived = record.archived;
                    if (request.action == "delete") state.history.Remove(record);
                    else record.archived = request.action == "archive";
                    try { Save(); } catch { state.history = previousHistory; record.archived = wasArchived; throw; }
                    historyRevision = Guid.NewGuid().ToString();
                    return;
                case "start":
                    if (state.session != null) throw new Exception("A focus session is already running.");
                    FocusSession.Validate(request.durationMinutes, request.unlockDelayMinutes, request.apps);
                    var apps = request.apps.GroupBy(a => a.path.ToLowerInvariant()).Select(g => g.First()).ToList();
                    foreach (var target in apps.Where(a => !Websites.IsWebsite(a))) ValidateTarget(target);
                    var screen = Websites.Validate(request.blockScreen, apps);
                    state.session = new FocusSession {
                        id = Guid.NewGuid().ToString(), intention = (request.intention ?? "Time to focus").Substring(0, Math.Min(120, (request.intention ?? "Time to focus").Length)),
                        durationMinutes = request.durationMinutes, unlockDelayMinutes = request.unlockDelayMinutes, scheduledEndsAt = request.scheduledEndsAt,
                        apps = apps, blockScreen = screen, startedAt = Now(), endsAt = FocusSession.ResolveEnd(request.durationMinutes, request.scheduledEndsAt, Now()), phase = "applying"
                    };
                    state.error = null;
                    websiteReady.Reset(); websiteAwaitId = apps.Any(Websites.IsWebsite) ? state.session.id : null;
                    try { Save(); } catch { state.session = null; throw; }
                    try {
                        Websites.Apply(apps);
                        if (apps.Any(a => !Websites.IsWebsite(a))) RunPolicy("apply", new { owner = owner, apps = apps.Where(a => !Websites.IsWebsite(a)).ToList() });
                        if (websiteAwaitId != null && !websiteReady.WaitOne(15000)) throw new Exception("Open Chrome or Edge with the Still companion connected and incognito / InPrivate access enabled before starting website blocking. Set it up in Settings.");
                        state.session.startedAt = Now(); state.session.endsAt = FocusSession.ResolveEnd(request.durationMinutes, request.scheduledEndsAt, Now());
                        state.session.phase = "active"; Save();
                    } catch (Exception startError) {
                        try { Finish("failed"); }
                        catch (Exception releaseError) { state.error = releaseError.Message; Save(); }
                        throw new Exception("Could not start protection: " + startError.Message);
                    }
                    return;
                case "requestUnlock":
                    RequireSession(); state.session.RequestUnlock(Now()); Save(); return;
                case "cancelUnlock":
                    RequireSession(); state.session.unlockAt = 0; Save(); return;
                case "end":
                    RequireSession();
                    if (!state.session.CanEnd(Now())) throw new Exception("The release waiting period has not finished yet.");
                    Finish("ended-early"); return;
                case "snooze":
                    if (state.session == null || state.session.id != request.id) return;
                    if (state.session.scheduledEndsAt == 0) throw new Exception("Only an alarm session can be snoozed.");
                    Finish("snoozed"); return;
                default: throw new Exception("Unknown command.");
            }
        }
        void RequireSession() {
            if (state.session == null || state.session.phase != "active") throw new Exception("No active session.");
        }
        static void ValidateTarget(TargetApp app) {
            if (app.path.StartsWith("appx:")) {
                if (!Regex.IsMatch(app.path, @"^appx:[a-zA-Z0-9.\-_]+_[a-zA-Z0-9]+$") || Regex.IsMatch(app.path, @"Microsoft\.(WindowsStore|DesktopAppInstaller|SecHealthUI|WindowsTerminal)|OpenAI\.Codex", RegexOptions.IgnoreCase))
                    throw new Exception("This is a protected Windows package.");
                return; // Installed package identity and system-package exclusions are checked by policy.ps1.
            }
            app.path = Path.GetFullPath(app.path);
            if (!File.Exists(app.path)) throw new Exception("The file no longer exists: " + app.path);
            var blockedNames = new string[] { "still", "still.guard", "electron", "powershell", "pwsh", "cmd", "conhost", "explorer", "taskmgr", "regedit", "sc", "services", "mmc", "winlogon", "csrss", "lsass", "svchost", "wininit", "dwm", "sihost", "userinit", "smss", "consent", "runtimebroker", "dllhost", "rundll32" };
            var name = Path.GetFileNameWithoutExtension(app.path).ToLowerInvariant();
            if (blockedNames.Contains(name) || name.StartsWith("still-") ||
                app.path.StartsWith(Environment.GetFolderPath(Environment.SpecialFolder.Windows) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) ||
                app.path.StartsWith(InstallDir + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) ||
                app.path.IndexOf(@"\WindowsApps\", StringComparison.OrdinalIgnoreCase) >= 0)
                throw new Exception("Windows components and Still cannot be selected. For Store apps, choose the package from the app picker instead of its .exe file.");
            if ((File.GetAttributes(app.path) & FileAttributes.ReparsePoint) != 0) throw new Exception("Select the original executable, not a symbolic link.");
            var version = FileVersionInfo.GetVersionInfo(app.path);
            if (blockedNames.Contains(Path.GetFileNameWithoutExtension(version.OriginalFilename ?? "").ToLowerInvariant()))
                throw new Exception("This is a protected Windows or Still component.");
            app.name = String.IsNullOrWhiteSpace(app.name) ? Path.GetFileNameWithoutExtension(app.path) : app.name.Substring(0, Math.Min(100, app.name.Length));
        }
    }
}
