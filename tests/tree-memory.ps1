# Prints the memory of a process and all its descendants: { count, privateMB, workingSetMB }.
# Private working set is what the processes use on their own (shared pages are not counted twice).
param([int]$RootPid)
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class Mem {
  [StructLayout(LayoutKind.Sequential)] public struct PMC2 { public uint cb, PageFaultCount; public UIntPtr PeakWorkingSetSize, WorkingSetSize, QuotaPeakPagedPoolUsage, QuotaPagedPoolUsage, QuotaPeakNonPagedPoolUsage, QuotaNonPagedPoolUsage, PagefileUsage, PeakPagefileUsage, PrivateUsage, PrivateWorkingSetSize; public ulong SharedCommitUsage; }
  [DllImport("psapi.dll")] static extern bool GetProcessMemoryInfo(IntPtr h, ref PMC2 c, uint cb);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  public static long[] Of(int pid) { var h = OpenProcess(0x1000 | 0x0010, false, pid); if (h == IntPtr.Zero) return null; try { var c = new PMC2 { cb = (uint)Marshal.SizeOf(typeof(PMC2)) }; if (!GetProcessMemoryInfo(h, ref c, c.cb)) return null; return new long[] { (long)c.PrivateWorkingSetSize, (long)c.WorkingSetSize }; } finally { CloseHandle(h); } }
}
"@
$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId
$ids = @($RootPid)
do { $kids = @($all | Where-Object { $ids -contains $_.ParentProcessId -and $ids -notcontains $_.ProcessId } | ForEach-Object { $_.ProcessId }); $ids += $kids } while ($kids.Count)
$private = 0; $ws = 0; $count = 0
foreach ($id in $ids) { $m = [Mem]::Of($id); if ($m) { $private += $m[0]; $ws += $m[1]; $count++ } }
[pscustomobject]@{ count = $count; privateMB = [math]::Round($private / 1MB, 1); workingSetMB = [math]::Round($ws / 1MB, 1) } | ConvertTo-Json -Compress
