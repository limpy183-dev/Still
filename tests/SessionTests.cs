using System;
using System.Collections.Generic;
using Still;
class SessionTests {
    static int count;
    static void Check(bool ok, string label) { if (!ok) throw new Exception(label); count++; }
    static void Main() {
        var s = new FocusSession { endsAt = 1000000, unlockDelayMinutes = 5 };
        Check(!s.CanEnd(1000), "Locked before release request");
        s.RequestUnlock(1000);
        Check(s.unlockAt == 301000, "Delay measured from request");
        s.RequestUnlock(2000);
        Check(s.unlockAt == 301000, "Repeated requests cannot reset waiting period");
        Check(!s.CanEnd(300999), "Early release rejected");
        Check(s.CanEnd(301000), "Release at deadline");
        s.unlockAt = 0;
        Check(!s.CanEnd(400000), "Cancellation restores lock");
        Check(s.Expired(1000000) && !s.Expired(999999), "Natural expiry boundary");
        Check(FocusSession.ResolveEnd(50, 0, 1000) == 3001000, "Manual sessions retain duration");
        Check(FocusSession.ResolveEnd(50, 50000, 1000) == 50000, "Scheduled sessions retain absolute end time");
        bool expired = false;
        try { FocusSession.ResolveEnd(50, 1000, 1000); } catch { expired = true; }
        Check(expired, "Expired scheduled window rejected");
        s.unlockDelayMinutes = 0;
        Check(s.CanEnd(1), "No-delay mode");
        var apps = new List<TargetApp> { new TargetApp { path = @"C:\Games\game.exe" } };
        FocusSession.Validate(25, 5, apps);
        foreach (var duration in new int[] { 0, -1, 1441 }) {
            bool rejected = false;
            try { FocusSession.Validate(duration, 0, apps); } catch { rejected = true; }
            Check(rejected, "Invalid duration rejected");
        }
        bool invalid = false;
        try { FocusSession.Validate(25, 121, apps); } catch { invalid = true; }
        Check(invalid, "Invalid delay rejected");
        invalid = false;
        try { FocusSession.Validate(25, 5, new List<TargetApp>()); } catch { invalid = true; }
        Check(invalid, "Empty selection rejected");
        var json = new System.Web.Script.Serialization.JavaScriptSerializer();
        s.unlockDelayMinutes = 5; s.RequestUnlock(700);
        var restored = json.Deserialize<FocusSession>(json.Serialize(s));
        Check(restored.unlockAt == s.unlockAt && !restored.CanEnd(1000), "Restart preserves release deadline");
        Console.WriteLine("Passed " + count + " native session checks.");
    }
}
