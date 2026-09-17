param([ValidateSet('apply','clear','check','preview')][string]$Action, [string]$Payload)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Import-Module AppLocker -ErrorAction Stop
$dataRoot = Join-Path $env:ProgramData 'Still'
$backup = Join-Path $dataRoot 'policy-before.xml'
$working = Join-Path $dataRoot 'policy-working.xml'
$prefix = 'Still Focus / '
$useCsp = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion').EditionID -like 'Core*'
$cspNamespace = 'root/cimv2/mdm/dmmap'
$cspParent = './Vendor/MSFT/AppLocker/ApplicationLaunchRestrictions/StillFocus-0d13031f-6337-4f99-95f1-93b1ff9da641'
$cspMarker = Join-Path $dataRoot 'csp-active'
$cspTypes = @{ Exe = 'EXE'; Appx = 'StoreApps' }

function Read-CspPolicy {
    [xml]$result = '<AppLockerPolicy Version="1" />'
    foreach ($type in @('Exe', 'Appx')) {
        $class = "MDM_AppLocker_ApplicationLaunchRestrictions01_$($cspTypes[$type])03"
        foreach ($instance in @(Get-CimInstance -Namespace $cspNamespace -ClassName $class)) {
            if ($instance.ParentID -ne $cspParent) { continue }
            [xml]$collection = [Net.WebUtility]::HtmlDecode($instance.Policy)
            [void]$result.DocumentElement.AppendChild($result.ImportNode($collection.DocumentElement, $true))
        }
    }
    return ,$result
}
function Write-CspPolicy([xml]$policy) {
    # Windows Home does not process local Group Policy. Use the native AppLocker CSP.
    # The guard runs as SYSTEM, as required by the device WMI bridge.
    [IO.File]::WriteAllText($cspMarker, 'Still focus rules')
    foreach ($type in @('Appx', 'Exe')) {
        $class = "MDM_AppLocker_ApplicationLaunchRestrictions01_$($cspTypes[$type])03"
        $collection = $policy.SelectSingleNode("/AppLockerPolicy/RuleCollection[@Type='$type']")
        $instances = @(Get-CimInstance -Namespace $cspNamespace -ClassName $class | Where-Object ParentID -eq $cspParent)
        if (!$collection -or !$collection.HasChildNodes) {
            $instances | Remove-CimInstance
        } else {
            $encoded = [Net.WebUtility]::HtmlEncode($collection.OuterXml)
            if ($instances.Count) { $instances | Set-CimInstance -Property @{ Policy = $encoded } | Out-Null }
            else { New-CimInstance -Namespace $cspNamespace -ClassName $class -Property @{ ParentID = $cspParent; InstanceID = $cspTypes[$type]; Policy = $encoded } | Out-Null }
        }
    }
}

function Read-Policy { [xml](Get-AppLockerPolicy -Local -Xml) }
function Write-Policy([xml]$policy) {
    $policy.Save($working)
    Set-AppLockerPolicy -XmlPolicy $working -ErrorAction Stop
    # Refresh on both apply and clear: writing the local GPO does not refresh enforcement.
    & "$env:WINDIR\System32\gpupdate.exe" /target:computer /force /wait:30 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Windows could not refresh its application-control policy.' }
}
function Get-Collection([xml]$policy, [string]$type) {
    $collection = $policy.SelectSingleNode("/AppLockerPolicy/RuleCollection[@Type='$type']")
    if (!$collection) {
        $collection = $policy.CreateElement('RuleCollection')
        $collection.SetAttribute('Type', $type)
        $collection.SetAttribute('EnforcementMode', 'NotConfigured')
        [void]$policy.DocumentElement.AppendChild($collection)
    }
    return ,$collection
}
function Add-Rule([xml]$policy, $collection, [string]$type, [string]$name, [string]$sid, [string]$action, [string]$condition) {
    $rule = $policy.CreateElement($type)
    $rule.SetAttribute('Id', [guid]::NewGuid().ToString())
    $rule.SetAttribute('Name', "$prefix$name")
    $rule.SetAttribute('Description', 'Temporary focus rule managed by the Still Windows service.')
    $rule.SetAttribute('UserOrGroupSid', $sid)
    $rule.SetAttribute('Action', $action)
    $rule.InnerXml = $condition
    [void]$collection.AppendChild($rule)
}
function Assert-Unmanaged {
    [xml]$effective = Get-AppLockerPolicy -Effective -Xml
    $foreign = @($effective.SelectNodes('/AppLockerPolicy/RuleCollection/*') | Where-Object {
        $_.LocalName -match '^File.*Rule$' -and !$_.Name.StartsWith($prefix)
    })
    if ($foreign.Count) { throw 'This PC already has application-control rules. Still will not change an existing policy. Use Still on an unmanaged personal PC.' }
    # MDM policy is not always exposed through Get-AppLockerPolicy. Refuse managed devices.
    if ((Get-CimInstance Win32_ComputerSystem).PartOfDomain) { throw 'Domain-managed PCs are not supported.' }
    if (Test-Path 'HKLM:\SOFTWARE\Microsoft\PolicyManager\Providers') {
        $enrolled = Get-ChildItem 'HKLM:\SOFTWARE\Microsoft\Enrollments' -ErrorAction SilentlyContinue | Where-Object {
            (Get-ItemProperty $_.PSPath -Name ProviderID -ErrorAction SilentlyContinue).ProviderID -eq 'MS DM Server'
        }
        if ($enrolled) { throw 'This PC is managed by an organization. Still will not modify its application-control policy.' }
    }
}

if ($Action -eq 'check') {
    Assert-Unmanaged
    $build = [int](Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion').CurrentBuildNumber
    if ($build -lt 19041) { throw 'Still requires an updated Windows 10 (2004+) or Windows 11 PC.' }
    'OK'
    exit
}

function Remove-FocusRules([xml]$policy, [xml]$before) {
    $changed = $false
    foreach ($type in @('Exe', 'Appx')) {
        $collection = $policy.SelectSingleNode("/AppLockerPolicy/RuleCollection[@Type='$type']")
        if (!$collection) { continue }
        $owned = @($collection.ChildNodes | Where-Object { $_.LocalName -match '^File.*Rule$' -and $_.Name.StartsWith($prefix) })
        if (!$owned.Count) { continue }
        $changed = $true
        foreach ($rule in $owned) { [void]$collection.RemoveChild($rule) }
        # Preserve concurrently-added third-party rules. Restore mode only for an empty collection.
        if (@($collection.ChildNodes | Where-Object { $_.LocalName -match '^File.*Rule$' }).Count -eq 0) {
            $old = $before.SelectSingleNode("/AppLockerPolicy/RuleCollection[@Type='$type']")
            $collection.SetAttribute('EnforcementMode', $(if ($old) { $old.EnforcementMode } else { 'NotConfigured' }))
        }
    }
    return $changed
}

if ($Action -eq 'clear') {
    if ($useCsp -and (Test-Path $cspMarker)) {
        Write-CspPolicy ([xml]'<AppLockerPolicy Version="1" />')
        if ((Read-CspPolicy).DocumentElement.HasChildNodes) { throw 'Windows has not removed all focus rules. Still will retry automatically.' }
        Remove-Item -LiteralPath $cspMarker
    }
    $policy = Read-Policy
    [xml]$before = if (Test-Path $backup) { Get-Content -Raw -LiteralPath $backup } else { '<AppLockerPolicy Version="1" />' }
    if (Remove-FocusRules $policy $before) { Write-Policy $policy }
    $remaining = @( (Read-Policy).SelectNodes('/AppLockerPolicy/RuleCollection/*') | Where-Object { $_.Name -and $_.Name.StartsWith($prefix) } )
    if ($remaining.Count) { throw 'Windows has not removed all focus rules. Still will retry automatically.' }
    if (Test-Path $backup) { Remove-Item -LiteralPath $backup }
    'OK'
    exit
}

Assert-Unmanaged
$request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Payload)) | ConvertFrom-Json
$policy = Read-Policy
$beforeXml = $policy.OuterXml
$exe = Get-Collection $policy 'Exe'
$appx = Get-Collection $policy 'Appx'
foreach ($collection in @($exe, $appx)) {
    foreach ($rule in @($collection.ChildNodes | Where-Object { $_.Name -and $_.Name.StartsWith($prefix) })) { [void]$collection.RemoveChild($rule) }
    $collection.SetAttribute('EnforcementMode', 'Enabled')
}
# An allow-all baseline is essential: AppLocker otherwise implicitly denies unrelated apps.
Add-Rule $policy $exe 'FilePathRule' 'Allow other executables' 'S-1-1-0' 'Allow' '<Conditions><FilePathCondition Path="*" /></Conditions>'
# EXE enforcement also affects packaged apps, so explicitly allow them.
Add-Rule $policy $appx 'FilePublisherRule' 'Allow packaged applications' 'S-1-1-0' 'Allow' '<Conditions><FilePublisherCondition PublisherName="*" ProductName="*" BinaryName="*"><BinaryVersionRange LowSection="0.0.0.0" HighSection="*" /></FilePublisherCondition></Conditions>'
$packages = @()
$desktopPaths = @()
foreach ($target in $request.apps) {
    if ($target.path.StartsWith('appx:')) {
        $family = $target.path.Substring(5)
        $package = Get-AppxPackage -User $request.owner | Where-Object { $_.PackageFamilyName -eq $family } | Select-Object -First 1
        if (!$package -or $package.IsFramework -or $package.IsResourcePackage -or $package.NonRemovable -or !$package.InstallLocation -or $package.InstallLocation.StartsWith($env:WINDIR, [StringComparison]::OrdinalIgnoreCase) -or $package.Name -match 'Microsoft\.(WindowsStore|DesktopAppInstaller|SecHealthUI|WindowsTerminal)|OpenAI\.Codex') {
            throw "This package is unavailable or is a protected Windows component: $($target.name)"
        }
        $packages += $package
        $publisher = [Security.SecurityElement]::Escape($package.Publisher)
        $product = [Security.SecurityElement]::Escape($package.Name)
        Add-Rule $policy $appx 'FilePublisherRule' $target.name $request.owner 'Deny' "<Conditions><FilePublisherCondition PublisherName=`"$publisher`" ProductName=`"$product`" BinaryName=`"*`"><BinaryVersionRange LowSection=`"0.0.0.0`" HighSection=`"*`" /></FilePublisherCondition></Conditions>"
        continue
    }
    $desktopPaths += $target.path
    $escaped = [Security.SecurityElement]::Escape($target.path)
    Add-Rule $policy $exe 'FilePathRule' $target.name $request.owner 'Deny' "<Conditions><FilePathCondition Path=`"$escaped`" /></Conditions>"
    $info = Get-AppLockerFileInformation -Path $target.path -ErrorAction Stop
    [xml]$hashPolicy = $info | New-AppLockerPolicy -RuleType Hash -User $request.owner -Xml -ErrorAction Stop
    $hashes = @($hashPolicy.SelectNodes('/AppLockerPolicy/RuleCollection/FileHashRule'))
    if (!$hashes.Count) { throw "Windows could not identify $($target.name). Choose its actual executable." }
    foreach ($hash in $hashes) {
        $rule = $policy.ImportNode($hash, $true)
        $rule.SetAttribute('Id', [guid]::NewGuid().ToString())
        $rule.SetAttribute('Name', "$prefix$($target.name) (file identity)")
        $rule.SetAttribute('Action', 'Deny')
        [void]$exe.AppendChild($rule)
    }
    # Preserve protection through signed app updates without blocking an entire publisher.
    if ($info.Publisher) {
        try {
            [xml]$signedPolicy = $info | New-AppLockerPolicy -RuleType Publisher -User $request.owner -Xml -ErrorAction Stop
            foreach ($signed in @($signedPolicy.SelectNodes('/AppLockerPolicy/RuleCollection/FilePublisherRule'))) {
                $condition = $signed.SelectSingleNode('Conditions/FilePublisherCondition')
                if ($condition.PublisherName -and $condition.PublisherName -ne '*' -and $condition.ProductName -and $condition.ProductName -ne '*' -and $condition.BinaryName -and $condition.BinaryName -ne '*') {
                    $rule = $policy.ImportNode($signed, $true)
                    $rule.SetAttribute('Id', [guid]::NewGuid().ToString())
                    $rule.SetAttribute('Name', "$prefix$($target.name) (signed identity)")
                    $rule.SetAttribute('Action', 'Deny')
                    $version = $rule.SelectSingleNode('Conditions/FilePublisherCondition/BinaryVersionRange')
                    $version.SetAttribute('LowSection', '0.0.0.0')
                    $version.SetAttribute('HighSection', '*')
                    [void]$exe.AppendChild($rule)
                }
            }
        } catch {
            # Some signed files expose metadata that AppLocker cannot turn into a publisher rule. Path and hash rules still protect them.
        }
    }
}
if ($Action -eq 'preview') { $policy.OuterXml; exit }
if (!(Test-Path $backup)) { [IO.File]::WriteAllText($backup, $beforeXml, [Text.UTF8Encoding]::new($false)) }
& "$env:WINDIR\System32\sc.exe" config AppIDSvc start= auto | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Windows could not configure the Application Identity service.' }
Start-Service AppIDSvc -ErrorAction Stop
if ($useCsp) { Write-CspPolicy $policy } else { Write-Policy $policy }
[xml]$effective = $null
for ($attempt = 0; $attempt -lt 20; $attempt++) {
    $effective = if ($useCsp) { Read-CspPolicy } else { [xml](Get-AppLockerPolicy -Effective -Xml) }
    if ($effective.SelectSingleNode('/AppLockerPolicy/RuleCollection[@Type="Exe"]').EnforcementMode -eq 'Enabled' -and $effective.SelectSingleNode('/AppLockerPolicy/RuleCollection[@Type="Appx"]').EnforcementMode -eq 'Enabled') { break }
    Start-Sleep -Milliseconds 500
}
if ($effective.SelectSingleNode('/AppLockerPolicy/RuleCollection[@Type="Exe"]').EnforcementMode -ne 'Enabled' -or $effective.SelectSingleNode('/AppLockerPolicy/RuleCollection[@Type="Appx"]').EnforcementMode -ne 'Enabled') {
    throw 'Windows did not enable enforcement. No focus session was started.'
}
$results = @()
# Get-AppLockerPolicy -Effective only reads Group Policy, not CSP policy.
$effective.Save($working)
if ($desktopPaths.Count) { $results += @(Test-AppLockerPolicy -XmlPolicy $working -Path $desktopPaths -User $request.owner) }
if ($packages.Count) { $results += @(Test-AppLockerPolicy -XmlPolicy $working -Packages $packages -User $request.owner) }
if ($results.Count -ne $request.apps.Count -or @($results | Where-Object { $_.PolicyDecision -ne 'Denied' }).Count) {
    throw 'Windows could not verify every selected block. No focus session was started.'
}
# Close already-running copies owned by this user only, after rules are in place.
Get-CimInstance Win32_Process | Where-Object {
    $runningPath = $_.ExecutablePath
    $runningPath -and (($desktopPaths -contains $runningPath) -or @($packages | Where-Object { $runningPath.StartsWith($_.InstallLocation + '\', [StringComparison]::OrdinalIgnoreCase) }).Count -gt 0)
} | ForEach-Object {
    $sid = Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid -ErrorAction SilentlyContinue
    if ($sid.Sid -eq $request.owner) {
        $result = Invoke-CimMethod -InputObject $_ -MethodName Terminate -Arguments @{ Reason = [uint32]0 } -ErrorAction Stop
        if ($result.ReturnValue -ne 0 -and (Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue)) { throw "Unable to close $($_.Name). Close it yourself and try again." }
    }
}
'OK'
