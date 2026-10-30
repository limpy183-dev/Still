# Builds Still in release mode and packs it: dist\Still\ (the app), dist\Still-<version>-Windows.zip (portable)
# and dist\Still-Setup-<version>.exe (the installer, with the app appended to it).
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
Set-Location $root
$version = (Select-String -Path "$root\Cargo.toml" -Pattern '^version = "(.+)"').Matches[0].Groups[1].Value

cargo build --release --workspace
if ($LASTEXITCODE -ne 0) { throw 'cargo build failed.' }
$bin = "$root\target\release"

$dist = "$root\dist"; $app = "$dist\Still"
if (Test-Path -LiteralPath $dist) { Remove-Item -LiteralPath $dist -Recurse -Force }
New-Item -ItemType Directory -Force "$app\guard" | Out-Null
Copy-Item "$bin\Still.exe" "$app\Still.exe"
Copy-Item "$bin\still-guard.exe" "$app\guard\Still.Guard.exe"
Copy-Item "$root\native\policy.ps1" "$app\guard\policy.ps1"
Copy-Item "$root\LICENSE" "$app\LICENSE"

Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = "$dist\Still-$version-Windows.zip"
[IO.Compression.ZipFile]::CreateFromDirectory($app, $zip, [IO.Compression.CompressionLevel]::Optimal, $true)

# The installer is the setup program followed by the app's zip and a 16-byte trailer ("STILLPAY" + zip length).
$payload = "$dist\payload.zip"
[IO.Compression.ZipFile]::CreateFromDirectory($app, $payload, [IO.Compression.CompressionLevel]::Optimal, $false)
$program = [IO.File]::ReadAllBytes("$bin\Still-Setup.exe"); $zipBytes = [IO.File]::ReadAllBytes($payload)
$trailer = [Text.Encoding]::ASCII.GetBytes('STILLPAY') + [BitConverter]::GetBytes([uint64]$zipBytes.Length)
$setup = "$dist\Still-Setup-$version.exe"
$stream = [IO.File]::Create($setup)
try { $stream.Write($program, 0, $program.Length); $stream.Write($zipBytes, 0, $zipBytes.Length); $stream.Write($trailer, 0, $trailer.Length) } finally { $stream.Dispose() }
Remove-Item $payload

Get-ChildItem $dist -File | ForEach-Object { '{0,-34} {1,6:N1} MB' -f $_.Name, ($_.Length / 1MB) }
