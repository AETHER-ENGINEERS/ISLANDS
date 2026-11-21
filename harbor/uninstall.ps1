<#
.SYNOPSIS
  Remove an island's Windows service. Its home (vault, chats, log, keys …) is left exactly as it is.

.DESCRIPTION
  Run in PowerShell as administrator. Stops the service (the core logs island.stop and closes its door) and deletes it.
  -RemoveApp also deletes <IslandHome>\app (the copied harbor, core and node.exe); everything else in the home stays.
  The island's keys stay sealed to NT SERVICE\<ServiceName>: install the service again under the same name to open
  them, or set them again.

.EXAMPLE
  .\harbor\uninstall.ps1 -ServiceName PandoraDee
#>
[CmdletBinding()]
param(
  [string] $ServiceName = 'PandoraDee',
  [string] $IslandHome,
  [switch] $RemoveApp
)
$ErrorActionPreference = 'Stop'
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { throw 'Run this in PowerShell as administrator.' }
$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if (-not $svc) { Write-Host "No service called $ServiceName."; return }
if ($svc.Status -ne 'Stopped') { Stop-Service -Name $ServiceName; $svc.WaitForStatus('Stopped', '00:00:30') }
sc.exe delete $ServiceName | Out-Null
if ($LASTEXITCODE) { throw "sc.exe delete failed ($LASTEXITCODE)" }
Write-Host "Removed the service $ServiceName. The island's home is untouched." -ForegroundColor Green
if ($RemoveApp) {
  if (-not $IslandHome) { throw 'Pass -IslandHome to remove <IslandHome>\app.' }
  Remove-Item -Recurse -Force (Join-Path ([IO.Path]::GetFullPath($IslandHome)) 'app')
  Write-Host "Removed $IslandHome\app."
}
