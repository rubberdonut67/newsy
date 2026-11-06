<#
.SYNOPSIS
  Moves a run-from-source Newsy over to the installed app, keeping its data.

.DESCRIPTION
  1. Stops the source setup (window, service, tray) and removes its logon task
     and shortcuts, so the two never run side by side.
  2. Copies the database and keys into %APPDATA%\Newsy\data, where the installed
     app keeps them. The originals in the project's data folder are left exactly
     where they are, as a fallback.
  3. Runs the installer silently, then starts Newsy in the background the way
     signing in to Windows will (service, tray icon and alerts; no window).

  To go back: uninstall Newsy from Settings > Apps, then run
  `newsy.cmd install` in the project folder again.

.PARAMETER Installer
  Path to Newsy-Setup-<version>.exe.
#>
param(
  [Parameter(Mandatory)] [string]$Installer
)

$ErrorActionPreference = 'Stop'
$ProjectDir = Split-Path -Parent $PSScriptRoot
$Service = Join-Path $PSScriptRoot 'newsy-service.ps1'
$From = Join-Path $ProjectDir 'data'
$To = Join-Path $env:APPDATA 'Newsy\data'
$Exe = Join-Path $env:LOCALAPPDATA 'Programs\Newsy\Newsy.exe'

if (-not (Test-Path $Installer)) { throw "Installer not found: $Installer" }
if (Test-Path (Join-Path $To 'newsy.db')) {
  throw "$To already holds a database. Move it aside first; this script never overwrites one."
}

Write-Host '1/3 Stopping the source setup...' -ForegroundColor Cyan
& $Service quit
& $Service uninstall
Start-Sleep -Seconds 2

Write-Host '2/3 Copying data...' -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path $To | Out-Null
# The -wal file holds the most recent writes; copying the database without it
# would lose them. All three are consistent now that the service is stopped.
foreach ($name in 'newsy.db', 'newsy.db-wal', 'newsy.db-shm', 'secrets.json', 'newsy.log') {
  $src = Join-Path $From $name
  if (Test-Path $src) {
    Copy-Item $src (Join-Path $To $name)
    Write-Host "  copied $name"
  }
}

Write-Host '3/3 Installing...' -ForegroundColor Cyan
Start-Process -FilePath $Installer -ArgumentList '/S' -Wait
if (-not (Test-Path $Exe)) { throw "Install did not produce $Exe" }
# Started the same way the sign-in entry starts it: everything but the window.
# Opening Newsy from the desktop icon then attaches to this instance.
Start-Process -FilePath $Exe -ArgumentList '--hidden'
Write-Host "Done. Newsy is installed at $Exe and running in the background." -ForegroundColor Green
