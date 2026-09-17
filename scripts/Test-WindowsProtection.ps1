param([switch]$RunLiveTest)
$ErrorActionPreference = 'Stop'
if (!$RunLiveTest) { throw 'This test installs Windows protection and temporarily blocks only a generated test executable. Run explicitly with -RunLiveTest in an elevated Windows PowerShell window.' }
if (!([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Open Windows PowerShell as administrator to run the live test.' }
$root = Split-Path $PSScriptRoot -Parent
$owner = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$fixtureDir = Join-Path $root ('test-results\live-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $fixtureDir | Out-Null
$fixture = Join-Path $fixtureDir 'StillHarmlessFixture.exe'
$renamed = Join-Path $fixtureDir 'RenamedFixture.exe'
$marker = Join-Path $fixtureDir 'executed.txt'
$source = Join-Path $fixtureDir 'Fixture.cs'
@'
using System;
using System.IO;
class Fixture {
    static void Main(string[] args) {
        if (args.Length > 0) File.WriteAllText(args[0], "executed");
        if (args.Length > 1) System.Threading.Thread.Sleep(300000);
    }
}
'@ | Set-Content -LiteralPath $source
& "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /target:winexe "/out:$fixture" $source
if ($LASTEXITCODE -ne 0) { throw 'Fixture compilation failed.' }
Copy-Item -LiteralPath $fixture -Destination $renamed
function Send-Guard($request) {
    $pipe = [IO.Pipes.NamedPipeClientStream]::new('.', 'Still.Focus.Guard.v1', [IO.Pipes.PipeDirection]::InOut)
    try {
        $pipe.Connect(5000)
        $writer = [IO.StreamWriter]::new($pipe, [Text.UTF8Encoding]::new($false), 4096, $true)
        $reader = [IO.StreamReader]::new($pipe, [Text.UTF8Encoding]::new($false), $false, 4096, $true)
        $writer.WriteLine(($request | ConvertTo-Json -Depth 6 -Compress)); $writer.Flush()
        $line = $reader.ReadLineAsync()
        if (!$line.Wait(120000)) { throw 'Guard request timed out.' }
        $reply = $line.Result | ConvertFrom-Json
        if (!$reply.ok) { throw $reply.error }
        return $reply
    } finally { $pipe.Dispose() }
}
$previousService = Get-Service StillFocusGuard -ErrorAction SilentlyContinue
$created = !$previousService
$testId = $null
try {
    if ($previousService -and $previousService.Status -ne 'Running') { Start-Service StillFocusGuard }
    if (!$previousService) {
        & "$root\scripts\build-native.ps1"
        Copy-Item -LiteralPath "$root\native\policy.ps1" -Destination "$root\native\bin\policy.ps1" -Force
        $install = Start-Process -FilePath "$root\native\bin\Still.Guard.exe" -ArgumentList @('--install', $owner) -WindowStyle Hidden -Wait -PassThru
        if ($install.ExitCode) { throw 'Guard installation failed.' }
    }
    $ready = $null
    for ($i = 0; $i -lt 20; $i++) { try { $ready = Send-Guard @{ command = 'status' }; break } catch { Start-Sleep -Seconds 1 } }
    if (!$ready) { throw 'Guard did not become ready.' }
    if ($ready.session) { throw 'An existing focus session is active. The test will not modify it.' }
    $running = Start-Process -FilePath $fixture -ArgumentList @("`"$marker`"", 'wait') -WindowStyle Hidden -PassThru
    Start-Sleep -Milliseconds 500
    if (!(Test-Path -LiteralPath $marker)) { throw 'Fixture could not run before protection.' }
    Remove-Item -LiteralPath $marker
    $active = Send-Guard @{ command = 'start'; durationMinutes = 1; unlockDelayMinutes = 1; intention = 'Windows protection smoke test'; apps = @(@{ name = 'Harmless test fixture'; path = $fixture }) }
    $testId = $active.session.id
    if (!$running.WaitForExit(5000)) { throw 'Already-running selected process was not closed.' }
    foreach ($file in @($fixture, $renamed)) {
        try { $p = Start-Process -FilePath $file -ArgumentList "`"$marker`"" -WindowStyle Hidden -PassThru; [void]$p.WaitForExit(2000) } catch { }
        if (Test-Path -LiteralPath $marker) { throw "Blocked executable ran: $file" }
    }
    $cmd = Start-Process -FilePath "$env:WINDIR\System32\cmd.exe" -ArgumentList "/d /c `"`"$fixture`" `"$marker`"`"" -WindowStyle Hidden -PassThru
    [void]$cmd.WaitForExit(5000)
    if (Test-Path -LiteralPath $marker) { throw 'Command-line launch bypassed protection.' }
    $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $fixtureDir 'Fixture.lnk'))
    $shortcut.TargetPath = $fixture; $shortcut.Arguments = "`"$marker`""; $shortcut.Save()
    try { Start-Process -FilePath (Join-Path $fixtureDir 'Fixture.lnk') -WindowStyle Hidden; Start-Sleep -Milliseconds 500 } catch { }
    if (Test-Path -LiteralPath $marker) { throw 'Shortcut launch bypassed protection.' }
    [void](Send-Guard @{ command = 'requestUnlock' })
    $rejected = $false
    try { [void](Send-Guard @{ command = 'end' }) } catch { $rejected = $true }
    if (!$rejected) { throw 'Early release was accepted before its waiting period.' }
    Write-Output 'Launch and early-release checks passed. Waiting for the one-minute session to expire…'
    $deadline = [DateTime]::UtcNow.AddSeconds(85)
    do { Start-Sleep -Seconds 1; $status = Send-Guard @{ command = 'status' } } while ($status.session -and [DateTime]::UtcNow -lt $deadline)
    if ($status.session) { throw 'The session did not expire and release its rules.' }
    $p = Start-Process -FilePath $fixture -ArgumentList "`"$marker`"" -WindowStyle Hidden -PassThru
    [void]$p.WaitForExit(5000)
    if (!(Test-Path -LiteralPath $marker)) { throw 'The fixture did not become available after expiry.' }
    Write-Output 'PASS: installed service, running-process closure, direct/renamed/command/shortcut denial, delayed release rejection, natural expiry, and launch restoration.'
} finally {
    if ($testId) {
        # Wait for this fixture's session only; never remove an unrelated session.
        $limit = [DateTime]::UtcNow.AddSeconds(100)
        do { try { $status = Send-Guard @{ command = 'status' } } catch { $status = $null; break }; if (!$status.session -or $status.session.id -ne $testId) { break }; Start-Sleep -Seconds 1 } while ([DateTime]::UtcNow -lt $limit)
        if ($status -and $status.session -and $status.session.id -eq $testId) { Write-Warning 'The test session has not released. Use the documented administrator recovery command.' }
    }
    if ($running -and !$running.HasExited) { Stop-Process -Id $running.Id -ErrorAction SilentlyContinue }
    if ($created) {
        try {
            $status = Send-Guard @{ command = 'status' }
            if (!$status.session) { Start-Process -FilePath "$env:ProgramFiles\Still Guard\Still.Guard.exe" -ArgumentList '--uninstall' -WindowStyle Hidden -Wait }
        } catch { Write-Warning 'Check Windows Services and the recovery instructions if the test guard remains installed.' }
    }
}
