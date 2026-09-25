$ErrorActionPreference = 'Stop'
# Packs the browser companion for the Chrome Web Store / Edge Add-ons: release/Still-Extension-<version>.zip
$root = Split-Path $PSScriptRoot -Parent
$source = Join-Path $root 'app/browser-extension'
$manifest = Get-Content -LiteralPath (Join-Path $source 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
# The stores assign their own ID and reject a "key"; the unpacked companion keeps it for a stable local ID.
$manifest.PSObject.Properties.Remove('key')
$out = Join-Path $root 'release'
New-Item -ItemType Directory -Force $out | Out-Null
$zip = Join-Path $out "Still-Extension-$($manifest.version).zip"
if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip }
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::Open($zip, 'Create')
try {
  # Forward-slash entry names; Compress-Archive on Windows PowerShell writes backslashes.
  $files = @('background.js', 'blocked.html', 'blocked.css', 'blocked.js', 'icons/icon-16.png', 'icons/icon-32.png', 'icons/icon-48.png', 'icons/icon-128.png')
  foreach ($file in $files) { [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, (Join-Path $source $file), $file) }
  [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, (Join-Path $root 'app/websites.js'), 'websites.js')
  $writer = New-Object IO.StreamWriter($archive.CreateEntry('manifest.json').Open(), (New-Object Text.UTF8Encoding($false)))
  try { $writer.Write(($manifest | ConvertTo-Json -Depth 10)) } finally { $writer.Dispose() }
} finally { $archive.Dispose() }
Write-Output "Store package: $zip"
