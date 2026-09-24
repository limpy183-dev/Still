param([switch]$StoreOnly, [string[]]$Executables = @())
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class StillIconResources {
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    public static extern uint ExtractIconEx(string file, int index, out IntPtr large, out IntPtr small, uint count);
    [DllImport("user32.dll")]
    public static extern bool DestroyIcon(IntPtr icon);
}
'@
function Get-ResourceIcon($locations) {
    foreach ($location in $locations) {
        $file = [Environment]::ExpandEnvironmentVariables($location)
        $index = 0
        if ($file -match '^(.*),\s*(-?\d+)$') { $file = $matches[1]; $index = [int]$matches[2] }
        $file = $file.Trim().Trim('"')
        if (!(Test-Path -LiteralPath $file -PathType Leaf)) { continue }
        $large = [IntPtr]::Zero; $small = [IntPtr]::Zero
        $bitmap = $null; $stream = $null; $icon = $null
        try {
            $null = [StillIconResources]::ExtractIconEx($file, $index, [ref]$large, [ref]$small, 1)
            $handle = if ($large -ne [IntPtr]::Zero) { $large } else { $small }
            if ($handle -eq [IntPtr]::Zero) { continue }
            $icon = [Drawing.Icon]::FromHandle($handle)
            $bitmap = $icon.ToBitmap()
            $stream = New-Object IO.MemoryStream
            $bitmap.Save($stream, [Drawing.Imaging.ImageFormat]::Png)
            return 'data:image/png;base64,' + [Convert]::ToBase64String($stream.ToArray())
        } catch { } finally {
            if ($stream) { $stream.Dispose() }
            if ($bitmap) { $bitmap.Dispose() }
            if ($icon) { $icon.Dispose() }
            if ($large -ne [IntPtr]::Zero) { $null = [StillIconResources]::DestroyIcon($large) }
            if ($small -ne [IntPtr]::Zero) { $null = [StillIconResources]::DestroyIcon($small) }
        }
    }
}
$items = @{}
$packageManager = $null
try {
    $null = [Windows.Management.Deployment.PackageManager,Windows.Management.Deployment,ContentType=WindowsRuntime]
    $packageManager = New-Object Windows.Management.Deployment.PackageManager
} catch { }
function Get-LogoPaths($package, $manifest) {
    $roots = @($package.InstallLocation)
    try { $roots += $packageManager.FindPackageForUser('', $package.PackageFullName).EffectivePath } catch { }
    $logos = @($manifest.Package.Applications.Application | ForEach-Object {
        $_.VisualElements.Square44x44Logo
        $_.VisualElements.Square150x150Logo
        $_.VisualElements.Logo
    }) + @($manifest.Package.Properties.Logo)
    foreach ($root in ($roots | Where-Object { $_ } | Select-Object -Unique)) {
        foreach ($logo in ($logos | Where-Object { $_ } | Select-Object -Unique)) {
            $file = Join-Path $root $logo
            if (Test-Path -LiteralPath $file -PathType Leaf) { $file }
            # Store manifests often name a logical asset; only qualified files exist on disk.
            $stem = [IO.Path]::GetFileNameWithoutExtension($file)
            $extension = [IO.Path]::GetExtension($file)
            Get-ChildItem -LiteralPath (Split-Path $file) -File | Where-Object {
                $_.Name.StartsWith($stem + '.', [StringComparison]::OrdinalIgnoreCase) -and $_.Extension -eq $extension
            } | Sort-Object @{ Expression = {
                if ($_.Name -match 'targetsize-(44|48).*lightunplated') { 0 }
                elseif ($_.Name -match 'targetsize-(44|48)' -and $_.Name -notmatch 'contrast|unplated') { 1 }
                elseif ($_.Name -match 'scale-100') { 2 }
                elseif ($_.Name -notmatch 'contrast|unplated') { 3 }
                else { 4 }
            } }, Name | Select-Object -First 8 -ExpandProperty FullName
            $flatFile = Join-Path $root ([IO.Path]::GetFileName($logo))
            if (Test-Path -LiteralPath $flatFile -PathType Leaf) { $flatFile }
        }
    }
}
function Add-App([string]$name, [string]$path, [string]$iconLocation) {
    $path = [Environment]::ExpandEnvironmentVariables($path.Trim('"'))
    if ($path -and $path.EndsWith('.exe', [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $path) -and !$path.StartsWith($env:WINDIR, [StringComparison]::OrdinalIgnoreCase)) {
        $key = $path.ToLowerInvariant()
        if (!$items.ContainsKey($key) -and $name -notmatch 'uninstall|setup|update|crash|helper|installer') {
            $items[$key] = @{ name = $name; path = $path; iconFiles = @() }
        }
        if ($iconLocation -and $items.ContainsKey($key)) { $items[$key].iconFiles += $iconLocation }
    }
}
if (!$StoreOnly) {
    $shell = New-Object -ComObject WScript.Shell
    foreach ($folder in @([Environment]::GetFolderPath('StartMenu'), [Environment]::GetFolderPath('CommonStartMenu'), [Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('CommonDesktopDirectory'))) {
        Get-ChildItem -LiteralPath $folder -Filter '*.lnk' -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
            $link = $shell.CreateShortcut($_.FullName)
            Add-App $_.BaseName $link.TargetPath $link.IconLocation
        }
    }
    foreach ($key in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\App Paths', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths')) {
        Get-ChildItem $key | ForEach-Object {
            $path = $_.GetValue('')
            if ($path) {
                $info = [Diagnostics.FileVersionInfo]::GetVersionInfo($path.Trim('"'))
                $name = if ($info.ProductName) { $info.ProductName } else { [IO.Path]::GetFileNameWithoutExtension($path) }
                Add-App $name $path
            }
        }
    }
    Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.Path } | ForEach-Object {
        $name = if ($_.Description) { $_.Description } else { $_.ProcessName }
        Add-App $name $_.Path
    }
    foreach ($file in $Executables) { Add-App ([IO.Path]::GetFileNameWithoutExtension($file)) $file }
}
Get-AppxPackage | Where-Object { !$_.IsFramework -and !$_.IsResourcePackage -and !$_.NonRemovable -and $_.InstallLocation -and !$_.InstallLocation.StartsWith($env:WINDIR, [StringComparison]::OrdinalIgnoreCase) -and $_.Name -notmatch 'Microsoft\.(WindowsStore|DesktopAppInstaller|SecHealthUI|WindowsTerminal)|OpenAI\.Codex' } | ForEach-Object {
    $package = $_
    $manifest = Get-AppxPackageManifest -Package $package
    if ($manifest.Package.Applications.Application) {
        $name = $manifest.Package.Properties.DisplayName
        if (!$name -or $name -like 'ms-resource:*') { $name = $package.Name -replace '^Microsoft\.', '' -replace '^MicrosoftCorporationII\.', '' }
        $packageExecutables = @($manifest.Package.Applications.Application | ForEach-Object {
            if ($_.Executable) {
                $file = Join-Path $package.InstallLocation $_.Executable
                if (Test-Path -LiteralPath $file -PathType Leaf) { $file }
                try {
                    $file = Join-Path $packageManager.FindPackageForUser('', $package.PackageFullName).EffectivePath $_.Executable
                    if (Test-Path -LiteralPath $file -PathType Leaf) { $file }
                } catch { }
            }
        } | Select-Object -Unique)
        $items['appx:' + $package.PackageFamilyName] = @{ name = [string]$name; path = 'appx:' + $package.PackageFamilyName; iconPaths = @(Get-LogoPaths $package $manifest | Select-Object -Unique); iconFiles = $packageExecutables }
    }
}
foreach ($item in $items.Values) {
    $locations = @($item.iconFiles)
    if (!$item.path.StartsWith('appx:')) { $locations += $item.path }
    $item.nativeIcon = Get-ResourceIcon $locations
    # Only plain files are suitable for Electron's shell fallback.
    $item.iconFiles = @($locations | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } | Select-Object -Unique)
}
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
ConvertTo-Json -InputObject @($items.Values | Sort-Object name) -Compress
