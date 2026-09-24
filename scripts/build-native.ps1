$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$out = Join-Path $root 'native/bin'
New-Item -ItemType Directory -Force $out | Out-Null
$compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
if (!(Test-Path -LiteralPath $compiler)) { throw 'Build on 64-bit Windows with .NET Framework 4.8 and Windows PowerShell 5.1 installed.' }
& $compiler /nologo /target:exe /platform:x64 "/out:$out\WindowsCompatibilityTests.exe" "$root\native\WindowsCompatibility.cs" "$root\tests\WindowsCompatibilityTests.cs"
if ($LASTEXITCODE -ne 0) { throw 'Compatibility test compilation failed.' }
& "$out/WindowsCompatibilityTests.exe"
if ($LASTEXITCODE -ne 0) { throw 'Windows compatibility tests failed.' }
# Product name and version on the guard binary (code signing requires them).
$version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
$info = Join-Path $out 'GuardInfo.cs'
Set-Content $info "[assembly: System.Reflection.AssemblyTitle(`"Still Guard`")]
[assembly: System.Reflection.AssemblyProduct(`"Still`")]
[assembly: System.Reflection.AssemblyCompany(`"Still`")]
[assembly: System.Reflection.AssemblyVersion(`"$version`")]
[assembly: System.Reflection.AssemblyFileVersion(`"$version`")]
[assembly: System.Reflection.AssemblyInformationalVersion(`"$version`")]"
& $compiler /nologo /target:winexe /optimize+ /platform:x64 /r:System.ServiceProcess.dll /r:System.Web.Extensions.dll /r:System.Windows.Forms.dll "/out:$out\Still.Guard.exe" "$info" "$root\native\Guard.cs" "$root\native\WindowsCompatibility.cs" "$root\native\Session.cs" "$root\native\Websites.cs"
if ($LASTEXITCODE -ne 0) { throw 'Native guard compilation failed.' }
& $compiler /nologo /target:exe /optimize+ /r:System.Web.Extensions.dll "/out:$out\SessionTests.exe" "$root\native\Session.cs" "$root\native\Websites.cs" "$root\tests\SessionTests.cs"
if ($LASTEXITCODE -ne 0) { throw 'Test compilation failed.' }
& "$out/SessionTests.exe"
if ($LASTEXITCODE -ne 0) { throw 'Session tests failed.' }
& $compiler /nologo /target:exe /main:GuardProtocolTests /optimize+ /r:System.ServiceProcess.dll /r:System.Web.Extensions.dll /r:System.Windows.Forms.dll "/out:$out\GuardProtocolTests.exe" "$root\native\Guard.cs" "$root\native\WindowsCompatibility.cs" "$root\native\Session.cs" "$root\native\Websites.cs" "$root\tests\GuardProtocolTests.cs"
if ($LASTEXITCODE -ne 0) { throw 'Protocol test compilation failed.' }
& "$out/GuardProtocolTests.exe"
if ($LASTEXITCODE -ne 0) { throw 'Protocol tests failed.' }

& $compiler /nologo /target:exe /optimize+ /r:System.Web.Extensions.dll "/out:$out\WebsitesTests.exe" "$root\native\Session.cs" "$root\native\Websites.cs" "$root\tests\WebsitesTests.cs"
if ($LASTEXITCODE -ne 0) { throw 'Website test compilation failed.' }
& "$out/WebsitesTests.exe"
if ($LASTEXITCODE -ne 0) { throw 'Website tests failed.' }
