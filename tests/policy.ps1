# Read-only policy integration: builds and evaluates rules, never installs them.
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$out = Join-Path $root 'test-results'
New-Item -ItemType Directory -Force $out | Out-Null
$owner = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$target = Join-Path $root 'native\bin\SessionTests.exe'
$renamed = Join-Path $out 'RenamedFocusTest.exe'
Copy-Item -LiteralPath $target -Destination $renamed -Force
$before = Get-AppLockerPolicy -Local -Xml
$request = @{ owner = $owner; apps = @(@{name = 'Harmless test fixture'; path = $target}) }
$payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($request | ConvertTo-Json -Depth 5 -Compress)))
[xml]$policy = & "$root\native\policy.ps1" -Action preview -Payload $payload
$policyFile = Join-Path $out 'test-policy.xml'
$policy.Save($policyFile)
$results = @(Test-AppLockerPolicy -XmlPolicy $policyFile -Path @($target, $renamed, "$root\native\bin\Still.Guard.exe") -User $owner)
if ($results.Count -ne 3) { throw 'Expected three policy evaluations.' }
foreach ($result in $results) {
    if ($result.FilePath -eq "$root\native\bin\Still.Guard.exe") {
        if ($result.PolicyDecision -ne 'Allowed') { throw 'Unrelated executable was not allowed.' }
    } elseif ($result.PolicyDecision -ne 'Denied') { throw "Selected or renamed binary was not denied: $($result.FilePath)" }
}
if ($policy.SelectNodes('/AppLockerPolicy/RuleCollection[@Type="Exe"]/FilePathRule[@Action="Allow"]').Count -ne 1) { throw 'Missing executable allow-all baseline.' }
if ($policy.SelectNodes('/AppLockerPolicy/RuleCollection[@Type="Appx"]/FilePublisherRule[@Action="Allow"]').Count -ne 1) { throw 'Missing packaged-app allow-all baseline.' }
$package = Get-AppxPackage | Where-Object { !$_.IsFramework -and !$_.IsResourcePackage -and !$_.NonRemovable -and $_.InstallLocation -and !$_.InstallLocation.StartsWith($env:WINDIR, [StringComparison]::OrdinalIgnoreCase) -and $_.Name -notmatch 'Microsoft\.(WindowsStore|DesktopAppInstaller|SecHealthUI|WindowsTerminal)|OpenAI\.Codex' } | Select-Object -First 1
if ($package) {
    $request.apps += @{ name = 'Packaged test target'; path = 'appx:' + $package.PackageFamilyName }
    $payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($request | ConvertTo-Json -Depth 5 -Compress)))
    [xml]$policy = & "$root\native\policy.ps1" -Action preview -Payload $payload
    $policy.Save($policyFile)
    $result = @(Test-AppLockerPolicy -XmlPolicy $policyFile -Packages @($package) -User $owner)
    if ($result.Count -ne 1 -or $result[0].PolicyDecision -ne 'Denied') { throw 'Selected package was not denied.' }
    Write-Output 'Passed: packaged app policy evaluation.'
}
if ((Get-AppLockerPolicy -Local -Xml) -ne $before) { throw 'Read-only test unexpectedly changed Windows policy.' }
Write-Output 'Passed: selected executable denied, renamed identical copy denied, unrelated executable allowed, EXE and Appx baselines present. Windows policy unchanged.'

# Exercise the real cleanup function in memory, including a concurrent foreign rule.
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile("$root\native\policy.ps1", [ref]$tokens, [ref]$errors)
$cleanup = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Remove-FocusRules' }, $true)
. ([scriptblock]::Create($cleanup.Extent.Text))
$prefix = 'Still Focus / '
[xml]$baseline = '<AppLockerPolicy Version="1"><RuleCollection Type="Exe" EnforcementMode="AuditOnly" /></AppLockerPolicy>'
[xml]$clean = $policy.OuterXml
if (!(Remove-FocusRules $clean $baseline)) { throw 'Cleanup did not detect owned rules.' }
if ($clean.SelectNodes('/AppLockerPolicy/RuleCollection/*').Count -ne 0) { throw 'Cleanup left owned rules behind.' }
if ($clean.SelectSingleNode('/AppLockerPolicy/RuleCollection[@Type="Exe"]').EnforcementMode -ne 'AuditOnly') { throw 'Cleanup did not restore the previous mode.' }
if (Remove-FocusRules $clean $baseline) { throw 'Repeated cleanup was not idempotent.' }
[xml]$withForeign = $policy.OuterXml
$foreign = $withForeign.CreateElement('FilePathRule'); $foreign.SetAttribute('Name', 'Independent policy'); $foreign.SetAttribute('Id', [guid]::NewGuid().ToString())
[void]$withForeign.SelectSingleNode('/AppLockerPolicy/RuleCollection[@Type="Exe"]').AppendChild($foreign)
[void](Remove-FocusRules $withForeign $baseline)
if ($withForeign.SelectNodes('/AppLockerPolicy/RuleCollection/FilePathRule[@Name="Independent policy"]').Count -ne 1) { throw 'Cleanup removed a third-party rule.' }
if ($withForeign.SelectSingleNode('/AppLockerPolicy/RuleCollection[@Type="Exe"]').EnforcementMode -ne 'Enabled') { throw 'Cleanup changed the mode of a collection with third-party rules.' }
Write-Output 'Passed: cleanup removes only owned rules, restores prior mode, preserves concurrent third-party rules, and is idempotent.'

# Windows binaries are used only in an unapplied preview to exercise signed identities.
$request.apps = @(@{name = 'Signed identity fixture'; path = "$env:WINDIR\System32\notepad.exe"})
$payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($request | ConvertTo-Json -Depth 5 -Compress)))
[xml]$signed = & "$root\native\policy.ps1" -Action preview -Payload $payload
$rules = @($signed.SelectNodes('/AppLockerPolicy/RuleCollection[@Type="Exe"]/FilePublisherRule[@Action="Deny"]'))
if (!$rules.Count) { throw 'Signed identity was not generated for the signed fixture.' }
foreach ($rule in $rules) {
    $identity = $rule.Conditions.FilePublisherCondition
    if ($identity.ProductName -eq '*' -or $identity.BinaryName -eq '*') { throw 'Publisher rule was overly broad.' }
    if ($identity.BinaryVersionRange.LowSection -ne '0.0.0.0' -or $identity.BinaryVersionRange.HighSection -ne '*') { throw 'Publisher rule does not cover updates.' }
}
Write-Output 'Passed: signed identity rules are scoped to product and binary, and cover all versions.'
