using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using Microsoft.Win32;
using Still;
class WebsitesTests {
    static int count;
    static void Check(bool ok, string label) { if (!ok) throw new Exception(label); count++; }
    static void Reject(Action action, string label) { bool rejected = false; try { action(); } catch { rejected = true; } Check(rejected, label); }
    static void Main(string[] args) {
        if (args.Length >= 2 && args[0] == "--host") { Websites.BrowserHost(args[1], args.Length > 2 ? args[2] : null); return; }
        var sites = new List<TargetApp> { new TargetApp { name = "YouTube", path = "website:youtube.com" } };
        FocusSession.Validate(25, 5, sites); Check(Websites.Domain(sites[0]) == "youtube.com", "Website-only session accepted");
        foreach (string host in new [] { "localhost", "127.0.0.1", "example.com\n", "*.example.com", "WWW.example.com", "a..com", "a.local" })
            Reject(() => Websites.Domain(new TargetApp { path = "website:" + host }), "Reject unsafe domain " + host);
        foreach (string url in new [] { "https://youtube.com", "https://m.youtube.com", "https://youtube.com./", "http://example.com", "https://127.0.0.1", "https://user:pass@example.com" })
            Reject(() => Websites.Validate(new BlockScreen { mode = "redirect", redirect = url }, sites), "Reject redirect " + url);
        Check(Websites.Validate(new BlockScreen { mode = "redirect", redirect = "https://example.com" }, sites).mode == "redirect", "Allowed redirect accepted");
        Reject(() => Websites.Validate(new BlockScreen { mode = "custom", image = "data:image/svg+xml;base64,AAAA" }, sites), "Reject executable image");
        var directory = Path.Combine(Path.GetTempPath(), "Still-websites-" + Guid.NewGuid()); Directory.CreateDirectory(directory);
        string testKey = @"Software\StillWebsiteTests\" + Guid.NewGuid();
        using (var root = Registry.CurrentUser.CreateSubKey(testKey)) {
            typeof(Websites).GetField("Journal", BindingFlags.NonPublic | BindingFlags.Static).SetValue(null, Path.Combine(directory, "journal.json"));
            typeof(Websites).GetField("PolicyRoot", BindingFlags.NonPublic | BindingFlags.Static).SetValue(null, root);
            const string chrome = @"SOFTWARE\Policies\Google\Chrome";
            try {
                using (var key = root.CreateSubKey(chrome + @"\URLBlocklist")) key.SetValue("1", "existing.example.com");
                Websites.Apply(sites);
                using (var key = root.OpenSubKey(chrome + @"\URLBlocklist")) {
                    Check((string)key.GetValue("1") == "existing.example.com", "Existing blocklist preserved");
                    Check((string)key.GetValue("2") == "youtube.com", "Domain policy uses contiguous indexes without overwriting values");
                }
                Check(File.Exists(Path.Combine(directory, "journal.json")), "Recovery journal persists");
                Websites.Clear(); Websites.Clear();
                using (var key = root.OpenSubKey(chrome + @"\URLBlocklist")) Check(key.ValueCount == 1, "Cleanup removes only Still rules and is idempotent");
                using (var key = root.CreateSubKey(chrome + @"\URLAllowlist")) key.SetValue("1", "youtube.com");
                Reject(() => Websites.Apply(sites), "Existing allowlist rejected before mutation");
                Check(!File.Exists(Path.Combine(directory, "journal.json")), "Conflict does not create undo state");
                root.DeleteSubKeyTree(chrome + @"\URLAllowlist");
                using (var key = root.CreateSubKey(chrome)) key.SetValue("BrowserGuestModeEnabled", 1, RegistryValueKind.DWord);
                Reject(() => Websites.Apply(sites), "Conflicting private/guest policy rejected");
            } finally { Registry.CurrentUser.DeleteSubKeyTree(testKey); Directory.Delete(directory, true); }
        }
        Console.WriteLine("Passed " + count + " website checks (isolated HKCU sandbox; real browser policies unchanged).");
    }
}
