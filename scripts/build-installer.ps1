# Packs release/win-unpacked into release/Still-Setup-<version>.exe (run `npm run dist` for the full build).
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
$app = Join-Path $root 'release/win-unpacked'
if (-not (Test-Path (Join-Path $app 'Still.exe'))) { throw 'release/win-unpacked is missing. Run npm run dist.' }
$work = Join-Path $root 'release/installer'
# Delete only this build's fixed staging folder.
if ([IO.Path]::GetFullPath($work) -ne [IO.Path]::GetFullPath((Join-Path $root 'release/installer'))) { throw 'Unexpected installer staging directory.' }
if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force }
New-Item -ItemType Directory -Force $work | Out-Null

Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::CreateFromDirectory($app, (Join-Path $work 'payload.zip'), [IO.Compression.CompressionLevel]::Optimal, $false)
Set-Content (Join-Path $work 'Version.cs') "[assembly: System.Reflection.AssemblyVersion(`"$version`")]
[assembly: System.Reflection.AssemblyFileVersion(`"$version`")]
[assembly: System.Reflection.AssemblyInformationalVersion(`"$version`")]
static partial class Setup { const string Version = `"$version`"; }"

$fx = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319'
$src = Join-Path $root 'installer'
# Parse the window now: a XAML mistake would otherwise only surface when a user opens the installer.
$xaml = (Join-Path $src 'Setup.xaml').Replace("'", "''")
$parseXaml = "`$ErrorActionPreference='Stop'; Add-Type -AssemblyName PresentationFramework; [Windows.Markup.XamlReader]::Load([IO.File]::OpenRead('$xaml')) | Out-Null"
& "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -STA -EncodedCommand ([Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($parseXaml)))
if ($LASTEXITCODE -ne 0) { throw 'installer/Setup.xaml is invalid.' }
$common = @('/nologo', '/target:winexe', '/optimize+', '/platform:x64',
  "/win32manifest:$src/app.manifest",
  "/r:$fx/WPF/PresentationFramework.dll", "/r:$fx/WPF/PresentationCore.dll", "/r:$fx/WPF/WindowsBase.dll", "/r:$fx/System.Xaml.dll",
  '/r:System.IO.Compression.dll', '/r:Microsoft.CSharp.dll', '/r:System.Core.dll') +
  (@('Setup.xaml', 'Manrope-Medium.ttf', 'Manrope-SemiBold.ttf', 'Manrope-ExtraBold.ttf') | ForEach-Object { "/resource:$src\$_,$_" })
$sources = @("$src\Setup.cs", "$work\Version.cs", "$root\native\WindowsCompatibility.cs")

$uninstaller = Join-Path $work 'Uninstall Still.exe'
& "$fx/csc.exe" @common "/win32icon:$root\assets\still.ico" "/out:$uninstaller" @sources
if ($LASTEXITCODE -ne 0) { throw 'Uninstaller compilation failed.' }
$setup = Join-Path $root "release/Still-Setup-$version.exe"
& "$fx/csc.exe" @common "/win32icon:$src\still-setup.ico" "/resource:$work\payload.zip,payload.zip" "/resource:$uninstaller,uninstaller.exe" "/out:$setup" @sources
if ($LASTEXITCODE -ne 0) { throw 'Installer compilation failed.' }
Write-Host "Built $setup ($([math]::Round((Get-Item $setup).Length / 1MB)) MB)"
