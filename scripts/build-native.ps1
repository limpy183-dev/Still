$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$out = Join-Path $root 'native/bin'
New-Item -ItemType Directory -Force $out | Out-Null
$compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
& $compiler /nologo /target:winexe /optimize+ /platform:x64 /r:System.ServiceProcess.dll /r:System.Web.Extensions.dll /r:System.Windows.Forms.dll "/out:$out\Still.Guard.exe" "$root\native\Guard.cs" "$root\native\Session.cs" "$root\native\Websites.cs"
if ($LASTEXITCODE -ne 0) { throw 'Native guard compilation failed.' }
& $compiler /nologo /target:exe /optimize+ /r:System.Web.Extensions.dll "/out:$out\SessionTests.exe" "$root\native\Session.cs" "$root\native\Websites.cs" "$root\tests\SessionTests.cs"
if ($LASTEXITCODE -ne 0) { throw 'Test compilation failed.' }
& "$out/SessionTests.exe"
if ($LASTEXITCODE -ne 0) { throw 'Session tests failed.' }
& $compiler /nologo /target:exe /main:GuardProtocolTests /optimize+ /r:System.ServiceProcess.dll /r:System.Web.Extensions.dll /r:System.Windows.Forms.dll "/out:$out\GuardProtocolTests.exe" "$root\native\Guard.cs" "$root\native\Session.cs" "$root\native\Websites.cs" "$root\tests\GuardProtocolTests.cs"
if ($LASTEXITCODE -ne 0) { throw 'Protocol test compilation failed.' }
& "$out/GuardProtocolTests.exe"
if ($LASTEXITCODE -ne 0) { throw 'Protocol tests failed.' }

& $compiler /nologo /target:exe /optimize+ /r:System.Web.Extensions.dll "/out:$out\WebsitesTests.exe" "$root\native\Session.cs" "$root\native\Websites.cs" "$root\tests\WebsitesTests.cs"
if ($LASTEXITCODE -ne 0) { throw 'Website test compilation failed.' }
& "$out/WebsitesTests.exe"
if ($LASTEXITCODE -ne 0) { throw 'Website tests failed.' }
