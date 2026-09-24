using System;
using System.Collections.Generic;
using System.IO;
using System.Text.RegularExpressions;

namespace Still {
    public class TargetApp {
        public string name { get; set; }
        public string path { get; set; }
    }
    public class FocusSession {
        public string id { get; set; }
        public bool archived { get; set; }
        public string intention { get; set; }
        public long startedAt { get; set; }
        public long endsAt { get; set; }
        public long scheduledEndsAt { get; set; }
        public int durationMinutes { get; set; }
        public int unlockDelayMinutes { get; set; }
        public long unlockAt { get; set; }
        public List<TargetApp> apps { get; set; }
        public BlockScreen blockScreen { get; set; }
        public FocusSession Summary() { var result = (FocusSession)MemberwiseClone(); result.blockScreen = null; return result; }
        public string phase { get; set; }
        public string outcome { get; set; }
        public long finishedAt { get; set; }
        public static long Now() { return (long)(DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds; }
        public static long ResolveEnd(int minutes, long scheduledEndsAt, long now) {
            if (scheduledEndsAt == 0) return now + minutes * 60000L;
            // A local time range can span 25 hours when daylight saving time ends.
            if (scheduledEndsAt <= now || scheduledEndsAt > now + 1500 * 60000L) throw new Exception("The scheduled focus window has ended or is too long.");
            return scheduledEndsAt;
        }
        public bool Expired(long now) { return now >= endsAt; }
        public bool CanEnd(long now) { return unlockDelayMinutes == 0 || (unlockAt > 0 && now >= unlockAt); }
        public void RequestUnlock(long now) { if (unlockAt == 0) unlockAt = now + unlockDelayMinutes * 60000L; }
        public static void Validate(int minutes, int delay, IList<TargetApp> apps) {
            if (minutes < 1 || minutes > 1440) throw new Exception("Choose a focus duration from 1 to 1,440 minutes.");
            if (delay < 0 || delay > 120) throw new Exception("Choose a release delay from 0 to 120 minutes.");
            if (apps == null || apps.Count == 0 || apps.Count > 100) throw new Exception("Select between 1 and 100 apps or websites.");
            foreach (var app in apps) {
                if (Websites.IsWebsite(app)) { Websites.Domain(app); continue; }
                if (app != null && app.path != null && Regex.IsMatch(app.path, @"^appx:[a-zA-Z0-9.\-_]+_[a-zA-Z0-9]+$")) continue;
                if (app == null || String.IsNullOrWhiteSpace(app.path) || !Path.IsPathRooted(app.path) ||
                    !app.path.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) || app.path.IndexOfAny(new char[] {'*', '?', '\r', '\n'}) >= 0)
                    throw new Exception("Select a full path to a Windows .exe file.");
            }
        }
    }
    public class GuardState {
        public FocusSession session { get; set; }
        public List<FocusSession> history { get; set; }
        public string error { get; set; }
        public GuardState() { history = new List<FocusSession>(); }
    }
}
