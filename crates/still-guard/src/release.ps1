# Releases every AppLocker rule Still added. Still.Guard.exe carries this script (release_rules in enforce.rs),
# so a deleted or quarantined policy.ps1 can never leave apps blocked.
# The functions are copies of policy.ps1's; tests/policy.ps1 checks that they stay identical.
param([ValidateSet('clear')][string]$Action, [string]$Payload)
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
