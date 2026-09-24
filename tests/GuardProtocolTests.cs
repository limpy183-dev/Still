using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Text;
using Still;

class GuardProtocolTests {
    static int count;
    static void Check(bool ok, string label) { if (!ok) throw new Exception(label); count++; }
    static object Call(Guard guard, string method, object value) {
        return typeof(Guard).GetMethod(method, BindingFlags.Instance | BindingFlags.Static | BindingFlags.NonPublic).Invoke(guard, new object[] { value });
    }
    static Dictionary<string, object> Status(Guard guard, Request request) { return (Dictionary<string, object>)Call(guard, "StatusResponse", request); }
    static void Main() {
        string directory = Path.Combine(Path.GetTempPath(), "Still-protocol-" + Guid.NewGuid());
        Directory.CreateDirectory(directory);
        // Test only the request/history code, with storage redirected away from the installed guard.
        typeof(Guard).GetField("StatePath", BindingFlags.Static | BindingFlags.NonPublic).SetValue(null, Path.Combine(directory, "state.json"));
        try {
            using (var guard = new Guard()) {
                var state = new GuardState();
                state.history.Add(new FocusSession { id = "record", apps = new List<TargetApp>() });
                typeof(Guard).GetField("state", BindingFlags.Instance | BindingFlags.NonPublic).SetValue(guard, state);
                var full = Status(guard, new Request { command = "status" });
                Check((bool)full["snoozeAlerts"], "Advertises alarm snooze support");
                state.session = new FocusSession { id = "manual", phase = "active", unlockDelayMinutes = 30, endsAt = FocusSession.Now() + 600000 };
                Call(guard, "Handle", new Request { command = "snooze", id = "other" });
                Check(state.session.id == "manual", "Snooze leaves unrelated sessions alone");
                bool rejected = false;
                try { Call(guard, "Handle", new Request { command = "snooze", id = "manual" }); }
                catch (TargetInvocationException error) { rejected = error.InnerException.Message.Contains("Only an alarm"); }
                Check(rejected && state.session.id == "manual", "Snooze cannot bypass a manual session delay");
                state.session = null;
                string token = (string)full["historyRevision"];
                Check(full.ContainsKey("history"), "Legacy request has full history");
                var compact = Status(guard, new Request { command = "status", historyRevision = token });
                Check(!compact.ContainsKey("history") && compact.ContainsKey("now") && compact.ContainsKey("session"), "Compact status retains live fields");
                Check(Status(guard, new Request { command = "start", historyRevision = token }).ContainsKey("history"), "Mutation response remains a snapshot");
                foreach (string action in new string[] { "archive", "restore", "delete" }) {
                    Call(guard, "Handle", new Request { command = "updateHistory", id = "record", action = action });
                    var updated = Status(guard, new Request { command = "status", historyRevision = token });
                    Check(updated.ContainsKey("history") && (string)updated["historyRevision"] != token, action + " changes revision");
                    token = (string)updated["historyRevision"];
                }
                using (var restarted = new Guard()) Check((string)Status(restarted, new Request { command = "status" })["historyRevision"] != token, "Restart changes token");
                foreach (int length in new int[] { 20, 1023, 1024, 32768, 65535 }) {
                    string input = new string('x', length);
                    using (var stream = new MemoryStream(Encoding.UTF8.GetBytes(input + "\nignored")))
                        Check((string)Call(null, "ReadRequest", stream) == input, "Bounded request " + length);
                }
                foreach (string input in new string[] { "partial", new string('x', 262144) + "\n" })
                    using (var stream = new MemoryStream(Encoding.UTF8.GetBytes(input)))
                        Check(Call(null, "ReadRequest", stream) == null, "Reject unterminated/oversized request");
            }
        } finally { Directory.Delete(directory, true); }
        Console.WriteLine("Passed " + count + " native protocol checks (no service or policy changes).");
    }
}
