param([switch]$RunLiveTest, [switch]$Website)
# Live check of the Rust Still Guard: installs it as the StillFocusGuard service and blocks only a generated harmless executable
# for one minute. If a Still Guard is already installed (for example the Electron app's C# guard), it is set aside, replaced by
# the Rust guard for the test, and put back afterwards. -Website also blocks example.com in Chrome/Edge, which needs Chrome or
# Edge open with the Still companion connected.
$ErrorActionPreference = 'Stop'
if (!$RunLiveTest) { throw 'This test installs Windows protection and temporarily blocks only a generated test executable. Run explicitly with -RunLiveTest in an elevated Windows PowerShell window.' }
if (!([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Open Windows PowerShell as administrator to run the live test.' }
$root = Split-Path $PSScriptRoot -Parent
$owner = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$rustGuard = Join-Path $root 'dist\Still\guard\Still.Guard.exe'
if (!(Test-Path -LiteralPath $rustGuard)) { throw 'dist\Still\guard\Still.Guard.exe is missing. Run scripts\build.ps1.' }
$installDir = Join-Path $env:ProgramFiles 'Still Guard'
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
function Wait-Guard {
    for ($i = 0; $i -lt 30; $i++) { try { return Send-Guard @{ command = 'status' } } catch { Start-Sleep -Seconds 1 } }
    throw 'Guard did not become ready.'
}
function Install-Guard($exe) {
    $process = Start-Process -FilePath $exe -ArgumentList @('--install', $owner) -WindowStyle Hidden -Wait -PassThru
    if ($process.ExitCode) { throw "Guard installation failed: $exe" }
}
function Assert-Blocked($what) {
    foreach ($file in @($fixture, $renamed)) {
        try { $p = Start-Process -FilePath $file -ArgumentList "`"$marker`"" -WindowStyle Hidden -PassThru; [void]$p.WaitForExit(2000) } catch { }
        if (Test-Path -LiteralPath $marker) { throw "Blocked executable ran ($what): $file" }
    }
}
function Blocklist($browser) {
    $key = "HKLM:\SOFTWARE\Policies\$browser\URLBlocklist"
    if (!(Test-Path $key)) { return @() }
    $values = Get-ItemProperty $key
    return @($values.PSObject.Properties | Where-Object { $_.Name -match '^\d+$' } | ForEach-Object { $_.Value })
}
$previousService = Get-Service StillFocusGuard -ErrorAction SilentlyContinue
$created = !$previousService
$previousGuard = $null
$testId = $null
try {
    if ($previousService) {
        if ($previousService.Status -ne 'Running') { Start-Service StillFocusGuard }
        if ((Wait-Guard).session) { throw 'An existing focus session is active. The test will not modify it.' }
        $installed = Join-Path $installDir 'Still.Guard.exe'
        if ((Get-FileHash -LiteralPath $installed).Hash -ne (Get-FileHash -LiteralPath $rustGuard).Hash) {
            # Keep the installed guard (and its policy script) aside; it reinstalls itself from there at the end.
            $previousGuard = Join-Path $fixtureDir 'previous-guard'
            New-Item -ItemType Directory -Force $previousGuard | Out-Null
            foreach ($file in @('Still.Guard.exe', 'policy.ps1')) { Copy-Item -LiteralPath (Join-Path $installDir $file) -Destination $previousGuard }
            Write-Output "Replacing the installed guard with the Rust guard for this test (a copy is kept in $previousGuard)."
            Install-Guard $rustGuard
        }
    } else { Install-Guard $rustGuard }
    if ((Get-FileHash -LiteralPath (Join-Path $installDir 'Still.Guard.exe')).Hash -ne (Get-FileHash -LiteralPath $rustGuard).Hash) { throw 'The installed guard is not the Rust guard.' }
    $ready = Wait-Guard
    if ($ready.session) { throw 'An existing focus session is active. The test will not modify it.' }
    $running = Start-Process -FilePath $fixture -ArgumentList @("`"$marker`"", 'wait') -WindowStyle Hidden -PassThru
    Start-Sleep -Milliseconds 500
    if (!(Test-Path -LiteralPath $marker)) { throw 'Fixture could not run before protection.' }
    Remove-Item -LiteralPath $marker
    $apps = @(@{ name = 'Harmless test fixture'; path = $fixture })
    if ($Website) { $apps += @{ name = 'example.com'; path = 'website:example.com' } }
    $active = Send-Guard @{ command = 'start'; durationMinutes = 1; unlockDelayMinutes = 1; intention = 'Windows protection smoke test'; apps = $apps }
    $testId = $active.session.id
    if (!$running.WaitForExit(5000)) { throw 'Already-running selected process was not closed.' }
    Assert-Blocked 'direct'
    $cmd = Start-Process -FilePath "$env:WINDIR\System32\cmd.exe" -ArgumentList "/d /c `"`"$fixture`" `"$marker`"`"" -WindowStyle Hidden -PassThru
    [void]$cmd.WaitForExit(5000)
    if (Test-Path -LiteralPath $marker) { throw 'Command-line launch bypassed protection.' }
    $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $fixtureDir 'Fixture.lnk'))
    $shortcut.TargetPath = $fixture; $shortcut.Arguments = "`"$marker`""; $shortcut.Save()
    try { Start-Process -FilePath (Join-Path $fixtureDir 'Fixture.lnk') -WindowStyle Hidden; Start-Sleep -Milliseconds 500 } catch { }
    if (Test-Path -LiteralPath $marker) { throw 'Shortcut launch bypassed protection.' }
    if ($Website) {
        foreach ($browser in @('Google\Chrome', 'Microsoft\Edge')) { if ((Blocklist $browser) -notcontains 'example.com') { throw "The $browser blocklist does not hold example.com." } }
    }
    [void](Send-Guard @{ command = 'requestUnlock' })
    $rejected = $false
    try { [void](Send-Guard @{ command = 'end' }) } catch { $rejected = $true }
    if (!$rejected) { throw 'Early release was accepted before its waiting period.' }
    # Recovery: the service is killed mid-session. Windows restarts it and it must pick the same session back up.
    $servicePid = (Get-CimInstance Win32_Service -Filter "Name='StillFocusGuard'").ProcessId
    Stop-Process -Id $servicePid -Force
    $recovered = $null
    $deadline = [DateTime]::UtcNow.AddSeconds(60)
    do { Start-Sleep -Seconds 1; try { $recovered = Send-Guard @{ command = 'status' } } catch { } } while ((!$recovered -or (Get-CimInstance Win32_Service -Filter "Name='StillFocusGuard'").ProcessId -eq $servicePid) -and [DateTime]::UtcNow -lt $deadline)
    if (!$recovered) { throw 'The guard did not come back after it was killed.' }
    if (!$recovered.session -or $recovered.session.id -ne $testId -or $recovered.session.phase -ne 'active') { throw 'The restarted guard lost the active session.' }
    Assert-Blocked 'after the guard restarted'
    Write-Output 'Launch, early-release and restart checks passed. Waiting for the one-minute session to expire…'
    $deadline = [DateTime]::UtcNow.AddSeconds(85)
    do { Start-Sleep -Seconds 1; $status = Send-Guard @{ command = 'status' } } while ($status.session -and [DateTime]::UtcNow -lt $deadline)
    if ($status.session) { throw 'The session did not expire and release its rules.' }
    $p = Start-Process -FilePath $fixture -ArgumentList "`"$marker`"" -WindowStyle Hidden -PassThru
    [void]$p.WaitForExit(5000)
    if (!(Test-Path -LiteralPath $marker)) { throw 'The fixture did not become available after expiry.' }
    if ($Website) {
        foreach ($browser in @('Google\Chrome', 'Microsoft\Edge')) { if ((Blocklist $browser) -contains 'example.com') { throw "The $browser blocklist still holds example.com after expiry." } }
        if (Test-Path (Join-Path $env:ProgramData 'Still\website-policy.json')) { throw 'The website policy journal was not cleared.' }
    }
    $record = $status.history | Where-Object { $_.id -eq $testId } | Select-Object -First 1
    if (!$record -or $record.outcome -ne 'completed') { throw 'The finished test session is not in the history as completed.' }
    Write-Output ('PASS: Rust guard installed as the service, running-process closure, direct/renamed/command/shortcut denial, delayed release rejection, restart after a crash with the session kept, natural expiry, history and launch restoration' + $(if ($Website) { ', browser blocklist set and cleared' } else { '' }) + '.')
} finally {
    if ($testId) {
        # Wait for this fixture's session only; never remove an unrelated session.
        $limit = [DateTime]::UtcNow.AddSeconds(100)
        do { try { $status = Send-Guard @{ command = 'status' } } catch { $status = $null; break }; if (!$status.session -or $status.session.id -ne $testId) { break }; Start-Sleep -Seconds 1 } while ([DateTime]::UtcNow -lt $limit)
        if ($status -and $status.session -and $status.session.id -eq $testId) { Write-Warning 'The test session has not released. Use the documented administrator recovery command.' }
    }
    if ($running -and !$running.HasExited) { Stop-Process -Id $running.Id -ErrorAction SilentlyContinue }
    if ($previousGuard) {
        try { Install-Guard (Join-Path $previousGuard 'Still.Guard.exe'); [void](Wait-Guard); Write-Output 'The previously installed guard is back in place.' }
        catch { Write-Warning "Could not put the previous guard back: $($_.Exception.Message). Reinstall it with: & '$previousGuard\Still.Guard.exe' --install $owner" }
    } elseif ($created) {
        try {
            $status = Send-Guard @{ command = 'status' }
            if (!$status.session) { Start-Process -FilePath "$installDir\Still.Guard.exe" -ArgumentList '--uninstall' -WindowStyle Hidden -Wait }
        } catch { Write-Warning 'Check Windows Services and the recovery instructions if the test guard remains installed.' }
    }
}
