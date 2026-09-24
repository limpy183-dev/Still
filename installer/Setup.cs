// Still Setup: installs or updates Still for the current Windows user (no administrator approval).
// Built without the embedded app payload, the same program is the uninstaller.
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Documents;
using System.Windows.Input;
using System.Windows.Markup;
using System.Windows.Media;
using System.Windows.Media.Animation;
using Microsoft.Win32;

[assembly: AssemblyTitle("Still Setup")]
[assembly: AssemblyProduct("Still")]
[assembly: AssemblyCompany("Still")]
[assembly: AssemblyDescription("Installs, updates and removes Still.")]

static partial class Setup {
    const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\Still";
    const string UninstallerName = "Uninstall Still.exe";
    const string Repository = "https://github.com/limpy183-dev/Still";
    static readonly string DefaultDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Still");
    // Same name as the shortcut Still writes for its notification identity, so there is never a duplicate.
    static readonly string StartMenuLink = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "Still Focus.lnk");
    static readonly string DesktopLink = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "Still.lnk");
    static readonly string GuardExe = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Still Guard", "Still.Guard.exe");

    static Window window;
    static bool uninstaller, busy, removeFolderOnExit;
    static string dir, installedVersion;

    [DllImport("kernel32.dll")] static extern bool SetDefaultDllDirectories(int flags);

    [STAThread]
    static int Main() {
        // Load native DLLs (e.g. WPF's d3dcompiler_47.dll) only from System32: never Still's copies next to the
        // uninstaller, which would lock them, nor a DLL planted beside the installer in Downloads.
        SetDefaultDllDirectories(0x800);
        bool first;
        using (new Mutex(true, @"Local\Still.Setup", out first)) {
            if (!first) return 0;
            uninstaller = Assembly.GetExecutingAssembly().GetManifestResourceInfo("payload.zip") == null;
            var app = new Application();
            app.DispatcherUnhandledException += (sender, e) => { Log(e.Exception); MessageBox.Show(e.Exception.Message, "Still Setup", MessageBoxButton.OK, MessageBoxImage.Error); };
            window = (Window)XamlReader.Load(Resource("Setup.xaml"));
            try { window.FontFamily = new FontFamily(new Uri(Fonts() + "\\"), "./#Manrope, Segoe UI Variable Text, Segoe UI"); } catch { /* the Windows font still looks at home */ }
            Get<TextBlock>("TitleText").Text = Spaced(uninstaller ? "STILL · UNINSTALL" : "STILL · SETUP " + Version);
            Get<FrameworkElement>("TitleBar").MouseLeftButtonDown += delegate { window.DragMove(); };
            Get<Button>("MinimizeButton").Click += delegate { window.WindowState = WindowState.Minimized; };
            Get<Button>("CloseButton").Click += delegate { window.Close(); };
            Get<Button>("SecondaryButton").Click += delegate { window.Close(); };
            Get<Button>("PrimaryButton").Click += delegate { Primary(); };
            window.Closing += (sender, e) => { if (busy) e.Cancel = true; };
            window.KeyDown += (sender, e) => { if (e.Key == Key.Escape && !busy) window.Close(); };
            app.Exit += delegate { if (removeFolderOnExit) RemoveFolderLater(); };
            if (uninstaller) UninstallWelcome(); else InstallWelcome();
            return app.Run(window);
        }
    }

    // ----- pages -----

    static Action primaryAction;
    static void Primary() { if (primaryAction != null) primaryAction(); }

    static void Page(string eyebrow, string heading, string accent, string body, string primary, Action action, string secondary, params string[] rows) {
        Get<TextBlock>("Eyebrow").Text = Spaced(eyebrow);
        var title = Get<TextBlock>("Heading");
        title.Inlines.Clear();
        title.Inlines.Add(new Run(heading));
        title.Inlines.Add(new Run(accent) { Foreground = Brush("#7D886E"), FontWeight = FontWeights.Medium });
        Get<TextBlock>("Body").Text = body;
        var primaryButton = Get<Button>("PrimaryButton");
        primaryButton.Content = primary;
        primaryButton.Visibility = primary == null ? Visibility.Collapsed : Visibility.Visible;
        primaryAction = action;
        var secondaryButton = Get<Button>("SecondaryButton");
        secondaryButton.Content = secondary;
        secondaryButton.Visibility = secondary == null ? Visibility.Collapsed : Visibility.Visible;
        Get<Button>("CloseButton").IsEnabled = !busy;
        bool first = true;
        foreach (Border row in Get<Panel>("Rows").Children) {
            row.Visibility = rows.Contains(row.Name) ? Visibility.Visible : Visibility.Collapsed;
            if (row.Visibility == Visibility.Visible) { row.BorderThickness = new Thickness(0, first ? 0 : 1, 0, 0); first = false; }
        }
        Get<FrameworkElement>("Card").Visibility = rows.Length == 0 ? Visibility.Collapsed : Visibility.Visible;
        Get<TextBlock>("Note").Text = "No account. No analytics. Everything stays on this PC.";
    }

    static void InstallWelcome() {
        using (var key = Registry.CurrentUser.OpenSubKey(UninstallKey)) {
            dir = key == null ? null : key.GetValue("InstallLocation") as string;
            installedVersion = key == null ? null : key.GetValue("DisplayVersion") as string;
        }
        if (dir == null || !File.Exists(Path.Combine(dir, "Still.exe"))) { dir = DefaultDir; installedVersion = null; }
        Get<TextBlock>("LocationText").Text = dir;
        Get<TextBlock>("LocationLabel").Text = installedVersion == null ? "Installs to" : "Installed in";
        Get<TextBlock>("VersionText").Text = installedVersion + "  →  " + Version;
        int order = installedVersion == null ? 0 : Compare(Version, installedVersion);
        if (installedVersion == null)
            Page("A QUIETER SPACE FOR YOUR ATTENTION", "Make room for ", "focus.", "Still helps you set distracting apps and websites aside, so there's space for what matters. Setup takes a moment and needs no administrator approval.", "Install Still", Install, "Cancel", "RowLocation", "RowDesktop");
        else if (order > 0)
            Page("A NEW VERSION IS READY", "A fresh ", "update.", "Still " + installedVersion + " is on this PC. Updating to " + Version + " keeps your sessions, preferences, alerts and to-dos exactly as they are.", "Update Still", Install, "Not now", "RowVersion", "RowLocation");
        else if (order == 0)
            Page("ALREADY INSTALLED", "Already ", "here.", "Still " + Version + " is already installed. Reinstall to repair it; your data stays just as it is.", "Reinstall", Install, "Close", "RowLocation");
        else
            Page("A NEWER VERSION IS INSTALLED", "Already ", "ahead.", "Still " + installedVersion + " is installed, which is newer than this setup (" + Version + "). Installing replaces it with the older version; your data stays as it is.", "Install " + Version, Install, "Close", "RowVersion", "RowLocation");
        RunningNote();
    }

    static void UninstallWelcome() {
        dir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
        string registered;
        using (var key = Registry.CurrentUser.OpenSubKey(UninstallKey)) registered = key == null ? null : key.GetValue("InstallLocation") as string;
        // Never empty a folder that isn't a Still installation (e.g. the uninstaller copied to Downloads).
        if (!File.Exists(Path.Combine(dir, "Still.exe")) && !string.Equals(registered, dir, StringComparison.OrdinalIgnoreCase)) {
            Page("NOTHING TO REMOVE", "Still isn't ", "here.", "This uninstaller only removes the Still installation it belongs to. Use Settings → Apps → Installed apps to remove Still.", null, null, "Close");
            return;
        }
        Page("UNINSTALL", "Leaving ", "so soon?", "This removes Still from this PC. Your focus is yours to keep; you're welcome back anytime.", "Uninstall", Uninstall, "Cancel", File.Exists(GuardExe) ? new[] { "RowGuard", "RowData" } : new[] { "RowData" });
        RunningNote();
    }

    static void RunningNote() {
        if (StillRunning()) Get<TextBlock>("Note").Text = "Still is open. It will close for a moment; Windows protection keeps running.";
    }

    static void Working(string heading, string accent, string body) {
        busy = true;
        Report(uninstaller ? "Tidying up…" : "Getting ready…", 0);
        Page("SETTLING IN", heading, accent, body, null, null, null, "RowProgress");
        var spin = new DoubleAnimation(0, 360, TimeSpan.FromSeconds(6)) { RepeatBehavior = RepeatBehavior.Forever };
        ((RotateTransform)window.FindName("OrbitSpin")).BeginAnimation(RotateTransform.AngleProperty, spin);
    }

    static void Idle() {
        busy = false;
        ((RotateTransform)window.FindName("OrbitSpin")).BeginAnimation(RotateTransform.AngleProperty, null);
    }

    static void Failed(Exception ex, Action retry) {
        Idle();
        Log(ex);
        Page("SETUP PAUSED", "Something got in ", "the way.", ex.Message, "Try again", retry, "Close");
    }

    static void Report(string status, double percent) {
        window.Dispatcher.BeginInvoke(new Action(() => {
            Get<TextBlock>("StatusText").Text = status;
            Get<TextBlock>("PercentText").Text = Math.Round(percent) + "%";
            Get<ProgressBar>("Progress").Value = percent;
        }));
    }

    // ----- install / update -----

    static async void Install() {
        bool update = installedVersion != null, desktop = Get<CheckBox>("DesktopSwitch").IsChecked == true;
        Working(update ? "Freshening " : "Making ", update ? "things up…" : "space…", "This only takes a moment. Your data stays exactly where it is.");
        try {
            await Task.Run(() => {
                Report("Closing Still…", 0);
                CloseStill();
                string staging = dir + ".new";
                DeleteDirectory(staging);
                long size = Extract(staging);
                using (var output = File.Create(Path.Combine(staging, UninstallerName))) Resource("uninstaller.exe").CopyTo(output);
                Report("Putting everything in place…", 96);
                Swap(staging, dir);
                Register(size);
                Shortcut(StartMenuLink);
                if (desktop || (update && File.Exists(DesktopLink))) Shortcut(DesktopLink);
                Report("Done", 100);
            });
            Idle();
            installedVersion = Version;
            if (update) Page("ALL DONE", "Up to ", "date.", "Still " + Version + " is ready, with everything just as you left it.", "Finish", Finish, null, "RowLaunch");
            else Page("ALL DONE", "All ", "set.", "Still " + Version + " is installed. A quieter space for your attention is one click away.", "Finish", Finish, null, "RowLaunch");
        } catch (Exception ex) { Failed(ex, Install); }
    }

    static long Extract(string target) {
        using (var zip = new ZipArchive(Resource("payload.zip"))) {
            long total = zip.Entries.Sum(e => e.Length), done = 0;
            var buffer = new byte[1 << 16];
            int shown = -1;
            foreach (var entry in zip.Entries) {
                string path = Path.GetFullPath(Path.Combine(target, entry.FullName));
                if (entry.FullName.EndsWith("/")) { Directory.CreateDirectory(path); continue; }
                Directory.CreateDirectory(Path.GetDirectoryName(path));
                using (var input = entry.Open())
                using (var output = File.Create(path)) {
                    int read;
                    while ((read = input.Read(buffer, 0, buffer.Length)) > 0) {
                        output.Write(buffer, 0, read);
                        done += read;
                        int percent = (int)(done * 95 / Math.Max(total, 1));
                        if (percent != shown) { shown = percent; Report("Copying Still…", percent); }
                    }
                }
            }
            return total;
        }
    }

    // Replace the whole folder at once so a failed update leaves the previous version working.
    static void Swap(string staging, string target) {
        string old = target + ".old";
        DeleteDirectory(old);
        if (Directory.Exists(target)) Retry(() => Directory.Move(target, old), "Still's files are in use. Close Still (including its tray icon) and try again.");
        try { Directory.Move(staging, target); }
        catch { if (Directory.Exists(old)) Directory.Move(old, target); throw; }
        try { DeleteDirectory(old); } catch { /* removed on the next update */ }
    }

    static void Register(long size) {
        using (var key = Registry.CurrentUser.CreateSubKey(UninstallKey)) {
            key.SetValue("DisplayName", "Still");
            key.SetValue("DisplayVersion", Version);
            key.SetValue("Publisher", "Still");
            key.SetValue("DisplayIcon", Path.Combine(dir, "Still.exe") + ",0");
            key.SetValue("InstallLocation", dir);
            key.SetValue("UninstallString", "\"" + Path.Combine(dir, UninstallerName) + "\"");
            key.SetValue("URLInfoAbout", Repository);
            key.SetValue("URLUpdateInfo", Repository + "/releases/latest");
            key.SetValue("InstallDate", DateTime.Now.ToString("yyyyMMdd"));
            key.SetValue("EstimatedSize", (int)(size / 1024), RegistryValueKind.DWord);
            key.SetValue("NoModify", 1, RegistryValueKind.DWord);
            key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
        }
    }

    static void Shortcut(string link) {
        Directory.CreateDirectory(Path.GetDirectoryName(link));
        dynamic shell = Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell"));
        try {
            var shortcut = shell.CreateShortcut(link);
            shortcut.TargetPath = Path.Combine(dir, "Still.exe");
            shortcut.WorkingDirectory = dir;
            shortcut.Description = "Still — a space for focus";
            shortcut.Save();
        } finally { Marshal.FinalReleaseComObject(shell); }
    }

    static void Finish() {
        if (Get<CheckBox>("LaunchSwitch").IsChecked == true)
            try { Process.Start(new ProcessStartInfo(Path.Combine(dir, "Still.exe")) { WorkingDirectory = dir, UseShellExecute = true }); } catch (Exception ex) { Log(ex); }
        window.Close();
    }

    // ----- uninstall -----

    static async void Uninstall() {
        bool guard = File.Exists(GuardExe) && Get<CheckBox>("GuardSwitch").IsChecked == true, data = Get<CheckBox>("DataSwitch").IsChecked == true;
        Working("Clearing ", "the way…", "Removing Still from this PC.");
        try {
            await Task.Run(() => {
                Report("Closing Still…", 10);
                CloseStill();
                if (guard) { Report("Removing Windows protection…", 25); RemoveGuard(data); }
                Report("Removing shortcuts…", 50);
                foreach (var link in new[] { StartMenuLink, DesktopLink }) if (File.Exists(link)) File.Delete(link);
                // "Open Still when you sign in" entries point at Still.exe in this folder.
                using (var run = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", true))
                using (var approved = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run", true))
                    if (run != null) foreach (var name in run.GetValueNames())
                        if ((run.GetValue(name) as string ?? "").IndexOf(dir, StringComparison.OrdinalIgnoreCase) >= 0) {
                            run.DeleteValue(name, false);
                            if (approved != null) approved.DeleteValue(name, false);
                        }
                if (data) {
                    Report("Removing your data…", 65);
                    // Electron names the data folder after package.json "name".
                    DeleteDirectory(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "still-focus"));
                    foreach (var browser in new[] { @"Google\Chrome", @"Microsoft\Edge" }) Registry.CurrentUser.DeleteSubKeyTree(@"Software\" + browser + @"\NativeMessagingHosts\app.still.focus", false);
                }
                Report("Removing Still…", 80);
                string self = Assembly.GetExecutingAssembly().Location;
                foreach (var entry in Directory.GetFileSystemEntries(dir)) {
                    if (string.Equals(entry, self, StringComparison.OrdinalIgnoreCase)) continue;
                    if (Directory.Exists(entry)) DeleteDirectory(entry); else Retry(() => File.Delete(entry), "Some of Still's files are in use. Close Still and try again.");
                }
                Registry.CurrentUser.DeleteSubKeyTree(UninstallKey, false);
                Report("Done", 100);
            });
            Idle();
            removeFolderOnExit = true;
            Page("ALL DONE", "Goodbye ", "for now.", "Still has been removed from this PC." + (data ? "" : " Your preferences and history are kept, in case you come back."), "Close", () => window.Close(), null);
        } catch (Exception ex) { Failed(ex, Uninstall); }
    }

    static void RemoveGuard(bool data) {
        // One administrator prompt: the guard releases its rules and unregisters, then its folders are removed.
        string folders = "rmdir /s /q \"" + Path.GetDirectoryName(GuardExe) + "\"";
        if (data) folders += " & rmdir /s /q \"" + Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "Still") + "\"";
        var start = new ProcessStartInfo("cmd.exe", "/c \"\"" + GuardExe + "\" --uninstall && (" + folders + " & exit /b 0)\"") { UseShellExecute = true, Verb = "runas", WindowStyle = ProcessWindowStyle.Hidden };
        try {
            using (var process = Process.Start(start)) {
                process.WaitForExit();
                if (process.ExitCode != 0) throw new Exception("Windows protection could not be removed. Finish any active focus session and try again, or switch off \"Remove Windows protection\".");
            }
        } catch (Win32Exception ex) {
            if (ex.NativeErrorCode == 1223) throw new Exception("Windows protection needs administrator approval to be removed. Try again, or switch off \"Remove Windows protection\" to keep it.");
            throw;
        }
    }

    // The running uninstaller can't delete itself, so a short-lived hidden command removes the folder after it exits.
    static void RemoveFolderLater() {
        Process.Start(new ProcessStartInfo("cmd.exe", "/c ping 127.0.0.1 -n 3 > nul & rmdir /s /q \"" + dir + "\"") { CreateNoWindow = true, UseShellExecute = false, WorkingDirectory = Path.GetTempPath() });
    }

    // ----- helpers -----

    static bool StillRunning() {
        var processes = Process.GetProcessesByName("Still");
        foreach (var process in processes) process.Dispose();
        return processes.Length > 0;
    }

    // Still hides to the tray instead of quitting on close, so it is stopped. Preferences are written atomically.
    static void CloseStill() {
        foreach (var process in Process.GetProcessesByName("Still"))
            using (process) try { process.Kill(); process.WaitForExit(10000); } catch { /* already gone, or another user's */ }
    }

    static void DeleteDirectory(string path) {
        if (Directory.Exists(path)) Retry(() => Directory.Delete(path, true), "Some of Still's files are in use. Close Still and try again.");
    }

    static void Retry(Action action, string message) {
        for (int attempt = 0; ; attempt++) {
            try { action(); return; }
            catch (Exception ex) {
                if (!(ex is IOException || ex is UnauthorizedAccessException)) throw;
                if (attempt == 20) throw new IOException(message, ex);
                Thread.Sleep(300);
            }
        }
    }

    static int Compare(string a, string b) {
        Version x, y;
        if (!System.Version.TryParse(a, out x) || !System.Version.TryParse(b, out y)) return string.CompareOrdinal(a, b);
        return x.CompareTo(y);
    }

    static string Fonts() {
        string folder = Path.Combine(Path.GetTempPath(), "Still-Setup-" + Version);
        Directory.CreateDirectory(folder);
        foreach (var name in new[] { "Manrope-Medium.ttf", "Manrope-SemiBold.ttf", "Manrope-ExtraBold.ttf" }) {
            string path = Path.Combine(folder, name);
            if (!File.Exists(path)) using (var output = File.Create(path)) Resource(name).CopyTo(output);
        }
        return folder;
    }

    // WPF has no letter-spacing; thin spaces give the small caps labels the app's airy tracking.
    static string Spaced(string text) { return string.Join(" ", text.ToCharArray()); }

    static Stream Resource(string name) { return Assembly.GetExecutingAssembly().GetManifestResourceStream(name); }
    static T Get<T>(string name) where T : class { return (T)window.FindName(name); }
    static SolidColorBrush Brush(string color) { return (SolidColorBrush)new BrushConverter().ConvertFromString(color); }
    static void Log(Exception ex) {
        try { File.AppendAllText(Path.Combine(Path.GetTempPath(), "Still-Setup.log"), DateTime.Now.ToString("s") + " " + ex + Environment.NewLine); } catch { }
    }
}
