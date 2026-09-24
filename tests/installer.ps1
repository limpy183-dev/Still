# Read the built uninstaller's actual helper code; no installation, registry or service changes.
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$assembly = [Reflection.Assembly]::LoadFile((Join-Path $root 'release/installer/Uninstall Still.exe'))
$setup = $assembly.GetType('Setup')
$flags = [Reflection.BindingFlags]'Static,NonPublic'
$quote = $setup.GetMethod('QuotePowerShell', $flags)
$powershell = $setup.GetMethod('PowerShell', $flags)
$validate = $setup.GetMethod('IsInstallDirectory', $flags)
$expected = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Programs\Still'
if (!$validate.Invoke($null, @("$expected"))) { throw 'Expected installation directory was refused.' }
foreach ($bad in @([IO.Path]::GetPathRoot($expected), (Split-Path $expected), "$expected-other")) {
    if ($validate.Invoke($null, @("$bad"))) { throw "Unsafe uninstall path accepted: $bad" }
}
# Build strings at runtime so Windows PowerShell's ANSI script reader cannot corrupt the test.
$sample = "D:\Users\O'Brien & 100% ! [user] `$name " + [char]0x0141 + [char]0x674e + '\Still'
$literal = $quote.Invoke($null, @("$sample"))
$start = $powershell.Invoke($null, @("[Console]::OutputEncoding=[Text.UTF8Encoding]::new(`$false); [Console]::Write($literal)"))
$start.RedirectStandardOutput = $true
$start.StandardOutputEncoding = [Text.Encoding]::UTF8
$process = [Diagnostics.Process]::Start($start)
$actual = $process.StandardOutput.ReadToEnd()
$process.WaitForExit()
if ($process.ExitCode -ne 0 -or $actual -cne $sample) { throw 'Special-character path did not round-trip through the uninstall command.' }
$process.Dispose()
'PASS: built installer path confinement and Unicode/quotes/percent/ampersand PowerShell command round-trip.'
