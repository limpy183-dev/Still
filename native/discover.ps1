param([switch]$StoreOnly)
$ErrorActionPreference = 'SilentlyContinue'
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
function Add-App([string]$name, [string]$path) {
    $path = [Environment]::ExpandEnvironmentVariables($path.Trim('"'))
    if ($path -and $path.EndsWith('.exe', [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $path) -and !$path.StartsWith($env:WINDIR, [StringComparison]::OrdinalIgnoreCase)) {
        $key = $path.ToLowerInvariant()
        if (!$items.ContainsKey($key) -and $name -notmatch 'uninstall|setup|update|crash|helper|installer') {
            $items[$key] = @{ name = $name; path = $path }
        }
    }
}
if (!$StoreOnly) {
    $shell = New-Object -ComObject WScript.Shell
    foreach ($folder in @([Environment]::GetFolderPath('StartMenu'), [Environment]::GetFolderPath('CommonStartMenu'), [Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('CommonDesktopDirectory'))) {
        Get-ChildItem -LiteralPath $folder -Filter '*.lnk' -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
            $link = $shell.CreateShortcut($_.FullName)
            Add-App $_.BaseName $link.TargetPath
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
}
Get-AppxPackage | Where-Object { !$_.IsFramework -and !$_.IsResourcePackage -and !$_.NonRemovable -and $_.InstallLocation -and !$_.InstallLocation.StartsWith($env:WINDIR, [StringComparison]::OrdinalIgnoreCase) -and $_.Name -notmatch 'Microsoft\.(WindowsStore|DesktopAppInstaller|SecHealthUI|WindowsTerminal)|OpenAI\.Codex' } | ForEach-Object {
    $package = $_
    $manifest = Get-AppxPackageManifest -Package $package
    if ($manifest.Package.Applications.Application) {
        $name = $manifest.Package.Properties.DisplayName
        if (!$name -or $name -like 'ms-resource:*') { $name = $package.Name -replace '^Microsoft\.', '' -replace '^MicrosoftCorporationII\.', '' }
        $items['appx:' + $package.PackageFamilyName] = @{ name = [string]$name; path = 'appx:' + $package.PackageFamilyName; iconPaths = @(Get-LogoPaths $package $manifest | Select-Object -Unique) }
    }
}
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
ConvertTo-Json -InputObject @($items.Values | Sort-Object name) -Compress
