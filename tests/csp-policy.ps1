# Exercise the production CSP transport in memory; never change Windows policy.
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile("$PSScriptRoot/../native/policy.ps1", [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw $errors[0] }
foreach ($name in @('Read-CspPolicy', 'Write-CspPolicy')) {
    $function = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
    . ([scriptblock]::Create($function.Extent.Text))
}
$cspNamespace = 'test'
$cspParent = 'Still-test'
$cspTypes = @{ Exe = 'EXE'; Appx = 'StoreApps' }
$cspMarker = [IO.Path]::GetTempFileName()
$script:instances = [Collections.Generic.List[object]]::new()
function Get-CimInstance($Namespace, $ClassName) { $script:instances | Where-Object Class -eq $ClassName }
function New-CimInstance($Namespace, $ClassName, $Property) { $Property.Class = $ClassName; $script:instances.Add([pscustomobject]$Property) }
function Set-CimInstance { param([Parameter(ValueFromPipeline)]$InputObject, $Property) process { $InputObject.Policy = $Property.Policy } }
function Remove-CimInstance { param([Parameter(ValueFromPipeline)]$InputObject) process { [void]$script:instances.Remove($InputObject) } }
try {
    $foreign = [pscustomobject]@{ Class = 'MDM_AppLocker_ApplicationLaunchRestrictions01_EXE03'; ParentID = 'Other policy'; Policy = 'Untouched' }
    $script:instances.Add($foreign)
    [xml]$policy = '<AppLockerPolicy Version="1"><RuleCollection Type="Exe" EnforcementMode="Enabled"><FilePathRule Name="Still Focus / A &amp; B" /></RuleCollection><RuleCollection Type="Appx" EnforcementMode="Enabled"><FilePublisherRule Name="Still Focus / Package" /></RuleCollection></AppLockerPolicy>'
    Write-CspPolicy $policy
    $read = Read-CspPolicy
    if ($read.OuterXml -ne $policy.OuterXml) { throw 'CSP round trip changed rules or XML escaping.' }
    Write-CspPolicy $policy
    if ($script:instances.Count -ne 3) { throw 'Updating CSP created duplicate collections.' }
    Write-CspPolicy ([xml]'<AppLockerPolicy Version="1" />')
    if ((Read-CspPolicy).DocumentElement.HasChildNodes) { throw 'Cleanup left owned collections.' }
    if ($script:instances.Count -ne 1 -or $foreign.Policy -ne 'Untouched') { throw 'Cleanup modified foreign policy.' }
    Write-CspPolicy ([xml]'<AppLockerPolicy Version="1" />')
    'PASS: CSP apply, encoded XML readback, update, scoped cleanup and repeated cleanup.'
} finally { Remove-Item -LiteralPath $cspMarker }
