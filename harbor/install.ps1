<#
.SYNOPSIS
  Install an island as a Windows service: the harbor, running as the island's own virtual account.

.DESCRIPTION
  Run once, in PowerShell as administrator, from a checkout where the harbor is built
  (dotnet publish harbor -c Release -r win-x64 --self-contained -p:PublishSingleFile=true -o build/harbor).

  What it does:
  1. Copies what the service runs into <IslandHome>\app: harbor.exe, the core (bin, src, package.json) and node.exe, so the
     island's account never needs anyone else's folders.
  2. Writes <IslandHome>\app\harbor.json: the home, the island's name, the front door's name, and who may open it.
  3. Creates the service, running as NT SERVICE\<ServiceName> (a virtual account: no password, no keyboard sign-in,
     not an administrator), started automatically, restarted if it stops unexpectedly.
  4. Sets the home folder's access: the island's account and -Person get full control; SYSTEM keeps access (for the
     service manager and backups); nobody else. Existing files keep their contents.
  5. Starts it, and waits for the core to answer.

  Run it again to update the app files; the home's own files (vault, chats, log, keys …) are never touched.
  -DryRun shows every step without doing any of them.

.EXAMPLE
  .\harbor\install.ps1 -IslandHome 'D:\Islands\Pandora' -Name "Pandora's island"
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string] $IslandHome,
  [string] $Name = 'island',
  [string] $ServiceName = 'PandoraDee',
  [string] $Pipe = 'pandora-island',
  [string] $Person = "$env:USERDOMAIN\$env:USERNAME",
  [string] $Node = (Get-Command node -ErrorAction SilentlyContinue).Source,
  [string] $Repo,
  [switch] $DryRun
)
$ErrorActionPreference = 'Stop'
if (-not $Repo) { $Repo = Split-Path -Parent $PSScriptRoot }   # the checkout this script is in

function Step([string] $what, [scriptblock] $do) {
  if ($DryRun) { Write-Host "would: $what" -ForegroundColor Cyan; return }
  Write-Host "· $what"
  & $do
}

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin -and -not $DryRun) { throw 'Run this in PowerShell as administrator (it creates a service and sets folder access).' }
if ($ServiceName -notmatch '^[A-Za-z][A-Za-z0-9_-]{1,60}$') { throw "ServiceName '$ServiceName' should be letters, digits, - and _." }
$harborExe = Join-Path $Repo 'build\harbor\harbor.exe'
if (-not (Test-Path $harborExe)) { throw "No harbor at $harborExe. Build it first: dotnet publish harbor -c Release -r win-x64 --self-contained -p:PublishSingleFile=true -o build/harbor" }
if (-not $Node -or -not (Test-Path $Node)) { throw 'No node.exe found. Pass -Node <path to node.exe> (Node 24 or newer, 64-bit).' }
$nodeVersion = & $Node --version
if ([int]($nodeVersion.TrimStart('v').Split('.')[0]) -lt 24) { throw "node $nodeVersion is too old: the core needs Node 24 or newer." }
try { [void](New-Object Security.Principal.NTAccount($Person)).Translate([Security.Principal.SecurityIdentifier]) } catch { throw "Windows doesn't know the account '$Person'. Pass -Person DOMAIN\name." }

$IslandHome = [IO.Path]::GetFullPath($IslandHome)
$app = Join-Path $IslandHome 'app'
$account = "NT SERVICE\$ServiceName"
$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue

Write-Host "Island '$Name' at $IslandHome, as $account; its door \\.\pipe\$Pipe opens for $Person." -ForegroundColor Green

if ($existing -and $existing.Status -ne 'Stopped') { Step "stop the running $ServiceName to update it" { Stop-Service -Name $ServiceName; (Get-Service $ServiceName).WaitForStatus('Stopped', '00:00:30') } }

Step "make $IslandHome and $app" { New-Item -ItemType Directory -Force -Path $IslandHome, $app, "$app\core", "$app\node" | Out-Null }
Step "copy harbor.exe, the core and node.exe into $app" {
  Copy-Item -Force $harborExe "$app\harbor.exe"
  foreach ($d in 'bin', 'src') { Remove-Item -Recurse -Force "$app\core\$d" -ErrorAction SilentlyContinue; Copy-Item -Recurse -Force (Join-Path $Repo "core\$d") "$app\core\$d" }
  Copy-Item -Force (Join-Path $Repo 'core\package.json') "$app\core\package.json"
  Copy-Item -Force $Node "$app\node\node.exe"
}
$config = [ordered]@{ serviceName = $ServiceName; home = $IslandHome; name = $Name; node = "$app\node\node.exe"; core = "$app\core\bin\island.ts"; pipe = $Pipe; people = @($Person) }
Step "write $app\harbor.json" { $config | ConvertTo-Json | Set-Content -Encoding UTF8 "$app\harbor.json" }

if (-not $existing) {
  Step "create the service $ServiceName" {
    New-Service -Name $ServiceName -BinaryPathName "`"$app\harbor.exe`" --config `"$app\harbor.json`"" -DisplayName "Island: $Name" -Description "The island's harbor: keeps its core running and guards its door. Home: $IslandHome" -StartupType Automatic | Out-Null
  }
}
Step "run it as $account, restart it if it stops, give it its own SID" {
  sc.exe config $ServiceName obj= $account | Out-Null
  sc.exe sidtype $ServiceName unrestricted | Out-Null
  sc.exe failure $ServiceName reset= 86400 actions= restart/5000/restart/30000/restart/60000 | Out-Null
  if ($LASTEXITCODE) { throw "sc.exe failed ($LASTEXITCODE)" }
}
Step "home access: $account and $Person full control, SYSTEM kept, nobody else" {
  icacls $IslandHome /inheritance:r /grant:r "${account}:(OI)(CI)F" "${Person}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' | Out-Null
  if ($LASTEXITCODE) { throw "icacls failed ($LASTEXITCODE)" }
  icacls "$IslandHome\*" /reset /T /C /Q | Out-Null   # everything inside follows the home's rules
}
Step "start $ServiceName and wait for the core" {
  Remove-Item -Force "$IslandHome\state\core.json" -ErrorAction SilentlyContinue
  Start-Service -Name $ServiceName
  $deadline = (Get-Date).AddSeconds(60)
  while (-not (Test-Path "$IslandHome\state\core.json")) {
    if ((Get-Date) -gt $deadline) { throw "The service started, but the core didn't come up. See $IslandHome\state\harbor.log and core.log." }
    Start-Sleep -Milliseconds 500
  }
  $h = Get-Content "$IslandHome\state\harbor.json" -Raw | ConvertFrom-Json
  Write-Host "Up: $($h.account) is running the island; its door is $($h.pipe)." -ForegroundColor Green
}
if ($DryRun) { Write-Host 'Dry run: nothing was changed.' -ForegroundColor Cyan }
