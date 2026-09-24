using System;
using Still;

class WindowsCompatibilityTests {
    static void Check(bool value, string label) { if (!value) throw new Exception(label); }
    static void Main() {
        foreach (int build in new[] { 19041, 19042, 19043, 19044, 19045 }) {
            Check(WindowsCompatibility.Problem(build, 2193, 528040, true, "Client") == null, "Updated Windows 10 " + build);
            Check(WindowsCompatibility.Problem(build, 2192, 528040, true, "Client") != null, "Unpatched Windows 10 " + build);
        }
        foreach (var version in new[] { new[] { 22000, 1165 }, new[] { 22621, 608 }, new[] { 22631, 0 }, new[] { 26100, 0 } })
            Check(WindowsCompatibility.Problem(version[0], version[1], 528040, true, "Client") == null, "Updated Windows 11");
        Check(WindowsCompatibility.Problem(22000, 1164, 528040, true, "Client") != null, "Unpatched Windows 11 21H2");
        Check(WindowsCompatibility.Problem(22621, 607, 528040, true, "Client") != null, "Unpatched Windows 11 22H2");
        Check(WindowsCompatibility.Problem(18363, 9999, 528040, true, "Client") != null, "Old Windows 10");
        Check(WindowsCompatibility.Problem(26100, 0, 528039, true, "Client") != null, "Missing .NET 4.8");
        Check(WindowsCompatibility.Problem(26100, 0, 528040, false, "Client") != null, "32-bit OS");
        Check(WindowsCompatibility.Problem(26100, 0, 528040, true, "Server") != null, "Server is not a client OS");
        Console.WriteLine("PASS: Windows 10/11 update boundaries, .NET, architecture and client OS requirements (simulated inputs).");
    }
}
