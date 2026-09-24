using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Pipes;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32;

namespace Still {
    public class BlockScreen {
        public string mode { get; set; }
        public string title { get; set; }
        public string text { get; set; }
        public string image { get; set; }
        public string redirect { get; set; }
    }
    public class WebsitePolicyValue {
        public string key { get; set; }
        public string name { get; set; }
        public string value { get; set; }
        public bool number { get; set; }
    }
    public static class Websites {
        public static bool IsWebsite(TargetApp app) { return app != null && app.path != null && app.path.StartsWith("website:", StringComparison.Ordinal); }
        public static string Domain(TargetApp app) {
            string host = app.path.Substring(8);
            if (host.Length > 253 || host != host.ToLowerInvariant() || host.StartsWith("www.") ||
                !Regex.IsMatch(host, @"^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?\z") ||
                Regex.IsMatch(host, @"\.(localhost|local|internal|test|invalid)$")) throw new Exception("Choose a public website domain.");
            return host;
        }
        public static BlockScreen Validate(BlockScreen screen, IEnumerable<TargetApp> apps) {
            if (screen == null) screen = new BlockScreen { mode = "garden" };
            if (!new [] { "garden", "dusk", "paper", "custom", "redirect" }.Contains(screen.mode)) throw new Exception("Choose a website block screen.");
            if ((screen.title ?? "").Length > 120 || (screen.text ?? "").Length > 1000 || (screen.image ?? "").Length > 180000) throw new Exception("The block screen is too large.");
            if (!String.IsNullOrEmpty(screen.image) && !Regex.IsMatch(screen.image, @"^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*\z")) throw new Exception("Invalid block-screen image.");
            if (screen.mode != "custom") screen.image = null;
            foreach (var target in apps.Where(IsWebsite)) Domain(target);
            if (screen.mode == "redirect") {
                Uri url;
                if (!Uri.TryCreate(screen.redirect, UriKind.Absolute, out url) || url.Scheme != "https" || url.UserInfo != "" || screen.redirect.Length > 2048) throw new Exception("Choose a valid HTTPS redirect.");
                string host = url.IdnHost.ToLowerInvariant().TrimEnd('.');
                Domain(new TargetApp { path = "website:" + (host.StartsWith("www.") ? host.Substring(4) : host) });
                if (apps.Where(IsWebsite).Any(a => host == Domain(a) || host.EndsWith("." + Domain(a)))) throw new Exception("The redirect destination is blocked.");
            }
            return screen;
        }

        // Only Still-owned values are journaled. Existing policies are never overwritten.
        static readonly string Journal = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "Still", "website-policy.json");
        static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 1024 * 1024 };
        static readonly RegistryKey PolicyRoot = Registry.LocalMachine;
        static readonly string[] Browsers = { @"SOFTWARE\Policies\Google\Chrome", @"SOFTWARE\Policies\Microsoft\Edge" };
        public static void Apply(IEnumerable<TargetApp> apps) {
            var domains = apps.Where(IsWebsite).Select(Domain).Distinct().ToArray();
            if (domains.Length == 0) return;
            if (File.Exists(Journal)) throw new Exception("Previous website rules need to be released first.");
            var values = new List<WebsitePolicyValue>();
            foreach (var browser in Browsers) {
                using (var allow = PolicyRoot.OpenSubKey(browser + @"\URLAllowlist"))
                    if (allow != null && allow.ValueCount > 0) throw new Exception("An existing browser allowlist can override website blocks. Still will not change it.");
                // Private/guest windows can omit unpacked extensions. Browser policy remains the fallback.
                AddScalar(values, browser, browser.EndsWith("Edge") ? "InPrivateModeAvailability" : "IncognitoModeAvailability", "1", true);
                AddScalar(values, browser, "BrowserGuestModeEnabled", "0", true);
                using (var key = PolicyRoot.OpenSubKey(browser + @"\URLBlocklist")) {
                    if (key != null && key.ValueCount + domains.Length + 2 > 1000) throw new Exception("The browser's URL blocklist is full. Still will not replace existing rules.");
                    // Windows browser policy lists use 1-based indexes. Fill unused slots.
                    int index = 1;
                    foreach (var domain in domains.Concat(new [] { "chrome://extensions", "edge://extensions" })) {
                        while (key != null && key.GetValue(index.ToString()) != null) index++;
                        values.Add(new WebsitePolicyValue { key = browser + @"\URLBlocklist", name = (index++).ToString(), value = domain });
                    }
                }
            }
            // Flush the complete undo journal BEFORE changing any policy. Recovery is idempotent.
            using (var stream = new FileStream(Journal, FileMode.CreateNew, FileAccess.Write, FileShare.None)) {
                var bytes = Encoding.UTF8.GetBytes(Json.Serialize(values)); stream.Write(bytes, 0, bytes.Length); stream.Flush(true);
            }
            foreach (var value in values) using (var key = PolicyRoot.CreateSubKey(value.key))
                key.SetValue(value.name, value.number ? (object)Int32.Parse(value.value) : value.value, value.number ? RegistryValueKind.DWord : RegistryValueKind.String);
        }
        static void AddScalar(List<WebsitePolicyValue> values, string path, string name, string value, bool number) {
            using (var key = PolicyRoot.OpenSubKey(path)) {
                var existing = key == null ? null : key.GetValue(name);
                if (existing != null) {
                    if (existing.ToString() != value) throw new Exception("A browser policy conflicts with website protection: " + name);
                    return;
                }
            }
            values.Add(new WebsitePolicyValue { key = path, name = name, value = value, number = number });
        }
        public static void Clear() {
            if (!File.Exists(Journal)) return;
            foreach (var value in Json.Deserialize<List<WebsitePolicyValue>>(File.ReadAllText(Journal)))
                using (var key = PolicyRoot.OpenSubKey(value.key, true)) {
                    var current = key == null ? null : key.GetValue(value.name);
                    if (current != null && current.ToString() == value.value) key.DeleteValue(value.name, false);
                }
            File.Delete(Journal);
        }
        // A native-messaging process lives with each connected browser. File notifications wake it
        // only when the SYSTEM guard writes state; there is no URL inspection or polling loop.
        public static int BrowserHost(string statePath = null) {
            if (statePath == null) statePath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "Still", "state.json");
            using (var changed = new AutoResetEvent(true))
            using (var watcher = new FileSystemWatcher(Path.GetDirectoryName(statePath), "state.json")) {
                watcher.NotifyFilter = NotifyFilters.LastWrite | NotifyFilters.FileName | NotifyFilters.Size;
                watcher.Changed += (s, e) => changed.Set(); watcher.Created += (s, e) => changed.Set(); watcher.Renamed += (s, e) => changed.Set();
                watcher.Error += (s, e) => changed.Set();
                watcher.EnableRaisingEvents = true;
                string previous = null;
                var output = Console.OpenStandardOutput();
                // Exit when the browser closes stdin, including while no state changes occur.
                bool closed = false;
                ThreadPool.QueueUserWorkItem(delegate {
                    try {
                        var input = Console.OpenStandardInput();
                        while (true) {
                            var header = ReadBytes(input, 4); if (header == null) break;
                            int length = BitConverter.ToInt32(header, 0); if (length <= 0 || length > 4096) break;
                            var body = ReadBytes(input, length); if (body == null) break;
                            var message = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(body));
                            object id;
                            if (message.TryGetValue("ready", out id) && id is string && ((string)id).Length <= 100) {
                                try {
                                    using (var pipe = new NamedPipeClientStream(".", "Still.Focus.Guard.v1", PipeDirection.InOut, PipeOptions.Asynchronous)) {
                                        pipe.Connect(3000);
                                        var request = Encoding.UTF8.GetBytes(new JavaScriptSerializer().Serialize(new { command = "websiteReady", id = (string)id }) + "\n");
                                        pipe.Write(request, 0, request.Length); pipe.Flush();
                                        var reply = new byte[64]; pipe.ReadAsync(reply, 0, reply.Length).Wait(5000);
                                    }
                                } catch { /* A restarted guard sends a fresh snapshot on its next save. */ }
                            }
                        }
                    } catch { }
                    closed = true; changed.Set();
                });
                while (!closed) {
                    changed.WaitOne(); if (closed) break;
                    try {
                        GuardState state = null;
                        for (int attempt = 0; attempt < 5; attempt++) {
                            try { state = Json.Deserialize<GuardState>(File.ReadAllText(statePath)); break; }
                            catch (IOException) { Thread.Sleep(50); }
                        }
                        if (state == null) continue; // Never clear blocks because a file was unreadable.
                        var session = state.session;
                        var screen = session == null ? null : session.blockScreen;
                        var data = Json.Serialize(new { sessionId = session == null ? null : session.id,
                            websites = session == null || session.apps == null ? new string[0] : session.apps.Where(IsWebsite).Select(Domain).ToArray(),
                            screen = screen == null ? null : new { mode = screen.mode, title = screen.title, text = screen.text, image = screen.image, redirect = screen.redirect },
                            endsAt = session == null ? 0 : session.endsAt });
                        if (previous == data) continue;
                        var bytes = Encoding.UTF8.GetBytes(data); var length = BitConverter.GetBytes(bytes.Length);
                        output.Write(length, 0, 4); output.Write(bytes, 0, bytes.Length); output.Flush(); previous = data;
                    } catch (IOException) { return 0; }
                    catch { /* Keep last confirmed rules on corrupt state; another save will retry. */ }
                }
            }
            return 0;
        }
        static byte[] ReadBytes(Stream input, int length) {
            var bytes = new byte[length]; int read = 0;
            while (read < length) { int count = input.Read(bytes, read, length - read); if (count == 0) return null; read += count; }
            return bytes;
        }
    }
}
