<#
.SYNOPSIS
  Removes the ReelForge autostart task, its launcher and its firewall rules.

.DESCRIPTION
  Stops and unregisters the Scheduled Task "ReelForge", deletes the generated launcher
  (<data>\autostart) and removes every firewall rule in the "ReelForge" group. Your projects,
  media and certificates in the data directory are kept unless -RemoveData is given.

  Run from an elevated PowerShell. -WhatIf shows what would happen without changing anything.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\windows\uninstall-autostart.ps1
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
  [string]$DataDir = $(if ($env:REELFORGE_DATA) { $env:REELFORGE_DATA } else { Join-Path $env:USERPROFILE '.reelforge' }),
  # Also delete the whole data directory (projects, media, exports, certificates). Irreversible.
  [switch]$RemoveData
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$TaskName = 'ReelForge'
$RuleGroup = 'ReelForge'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$isAdmin = (New-Object Security.Principal.WindowsPrincipal $identity).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $WhatIfPreference -and -not $isAdmin) {
  throw 'Run this script from an elevated PowerShell (Run as administrator): firewall rules need it.'
}

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task -and $PSCmdlet.ShouldProcess($TaskName, 'Stop and unregister scheduled task')) {
  if ($task.State -eq 'Running') { Stop-ScheduledTask -TaskName $TaskName }
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

$rules = @(Get-NetFirewallRule -Group $RuleGroup -ErrorAction SilentlyContinue)
if ($rules.Count -gt 0 -and $PSCmdlet.ShouldProcess("firewall group $RuleGroup", "Remove $($rules.Count) rule(s)")) {
  $rules | Remove-NetFirewallRule
}

$autostartDir = Join-Path $DataDir 'autostart'
if ((Test-Path $autostartDir) -and $PSCmdlet.ShouldProcess($autostartDir, 'Delete launcher')) {
  Remove-Item -Recurse -Force $autostartDir
}

if ($RemoveData -and (Test-Path $DataDir) -and
    $PSCmdlet.ShouldProcess($DataDir, 'Delete ALL ReelForge data (projects, media, exports, certificates)')) {
  Remove-Item -Recurse -Force $DataDir
}

$verb = if ($WhatIfPreference) { 'would be removed (dry run)' } else { 'removed' }
Write-Host "ReelForge autostart $verb." -ForegroundColor Green
if (-not $RemoveData) { Write-Host "Your data is still in $DataDir (use -RemoveData to delete it)." }
