<#
.SYNOPSIS
  Install, remove and control Newsy as a background Windows task.

.DESCRIPTION
  Registers a Scheduled Task that starts Newsy at logon with no console window,
  restarts it if it crashes, and keeps running on battery. Invoke this through
  newsy.cmd rather than directly, so PowerShell's execution policy does not
  block it.

  Commands: install | uninstall | start | stop | status | logs | open | desktop
#>
param(
  [Parameter(Position = 0)]
  [ValidateSet('install', 'uninstall', 'start', 'stop', 'quit', 'status', 'logs', 'open', 'desktop', 'shortcut', 'tray')]
  [string]$Command = 'status',

  [int]$Lines = 40
)

$ErrorActionPreference = 'Stop'

$TaskName    = 'Newsy'
$ProjectDir  = Split-Path -Parent $PSScriptRoot
# The logon task starts the service *and* the tray; the plain launcher starts
# only the service, for `newsy start`.
$Launcher    = Join-Path $PSScriptRoot 'newsy-startup.vbs'
$ServiceOnly = Join-Path $PSScriptRoot 'newsy-hidden.vbs'
$TrayLauncher = Join-Path $PSScriptRoot 'newsy-tray-hidden.vbs'
$OpenLauncher = Join-Path $PSScriptRoot 'newsy-open.vbs'
# The data folder is movable from the Developer tab, so the log is not always
# under the project. data-location.json is the record of where it went; without
# one, the default still applies.
$DataDir = Join-Path $ProjectDir 'data'
if ($env:DATA_DIR) {
  $DataDir = $env:DATA_DIR
} else {
  $locationFile = Join-Path $ProjectDir 'data-location.json'
  if (Test-Path $locationFile) {
    try {
      $chosen = (Get-Content $locationFile -Raw | ConvertFrom-Json).dataDir
      if ($chosen) { $DataDir = $chosen }
    } catch {
      # Unreadable: fall back to the default rather than failing outright.
    }
  }
}
$LogFile     = Join-Path $DataDir 'newsy.log'
$Port        = if ($env:PORT) { $env:PORT } else { 3000 }
$Url         = "http://localhost:$Port"

function Get-NewsyProcess {
  # Must match THIS project's directory, not merely "src/index.ts" — sibling
  # projects under the same parent folder share that layout, and matching on it
  # alone would kill unrelated apps.
  $dir = [regex]::Escape($ProjectDir)
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
    Where-Object {
      $_.CommandLine -and
      $_.CommandLine -match $dir -and
      # Either path separator: launching by hand gives "src/index.ts", the VBS
      # launcher builds "src\index.ts".
      $_.CommandLine -match 'src[\\/]index\.ts'
    }
}

function Get-NewsyWindow {
  # The app window this project opened, and only that one. There are two shapes
  # of it now: the Electron shell (the default since 21 Aug 2026) and the older
  # Chrome/Edge app-mode window, which still works and is still supported.
  $dir = [regex]::Escape($ProjectDir)

  # Only the Electron *main* process carries desktop\main.js; the gpu, utility
  # and renderer children are all --type= and exit with their parent, so matching
  # the parent alone tears the whole tree down. Matching this project's directory
  # is what keeps a sibling project's Electron app out of the net.
  $shell = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue -Filter "Name = 'electron.exe'" |
    Where-Object {
      $_.CommandLine -and
      $_.CommandLine -match $dir -and
      $_.CommandLine -match 'desktop[\\/]main\.js'
    }

  $appMode = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue -Filter "Name = 'chrome.exe' OR Name = 'msedge.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine -match "--app=http://localhost:$Port(\s|$)" }

  @($shell) + @($appMode) | Where-Object { $_ }
}

function Get-NewsyTray {
  $dir = [regex]::Escape($ProjectDir)
  Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -match $dir -and $_.CommandLine -match 'newsy-tray\.ps1' }
}

function New-NewsyShortcuts {
  $opener = Join-Path $PSScriptRoot 'newsy-open.vbs'
  $icon   = Join-Path $ProjectDir 'public\newsy.ico'

  $targets = @(
    (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Newsy.lnk'),
    (Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs\Newsy.lnk')
  )

  $shell = New-Object -ComObject WScript.Shell
  foreach ($target in $targets) {
    $parent = Split-Path -Parent $target
    if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }

    $lnk = $shell.CreateShortcut($target)
    # wscript.exe runs the .vbs with no console window; the .vbs starts the
    # service if needed, then opens the dashboard.
    $lnk.TargetPath       = Join-Path $env:SystemRoot 'System32\wscript.exe'
    $lnk.Arguments        = '"{0}"' -f $opener
    $lnk.WorkingDirectory = $ProjectDir
    $lnk.IconLocation     = "$icon,0"
    $lnk.Description      = 'Open Newsy'
    $lnk.Save()
    Write-Host "  created $target"
  }
  [Runtime.InteropServices.Marshal]::ReleaseComObject($shell) | Out-Null
}

function Test-NewsyResponding {
  try {
    $null = Invoke-RestMethod "$Url/api/health" -TimeoutSec 4
    return $true
  } catch {
    return $false
  }
}

switch ($Command) {

  'install' {
    $action = New-ScheduledTaskAction -Execute 'wscript.exe' `
      -Argument "`"$Launcher`"" -WorkingDirectory $ProjectDir

    # Delay slightly so the network stack is up before the first sweep.
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $trigger.Delay = 'PT30S'

    $settings = New-ScheduledTaskSettingsSet `
      -AllowStartIfOnBatteries `
      -DontStopIfGoingOnBatteries `
      -StartWhenAvailable `
      -RestartCount 5 `
      -RestartInterval (New-TimeSpan -Minutes 1) `
      -ExecutionTimeLimit ([TimeSpan]::Zero) `
      -MultipleInstances IgnoreNew

    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
      -Settings $settings -Description 'Newsy — background news monitoring and alerts' `
      -Force | Out-Null

    Write-Host "Installed scheduled task '$TaskName'." -ForegroundColor Green
    Write-Host "  Starts automatically 30s after you log in."
    Write-Host "  Restarts up to 5 times if it crashes; keeps running on battery."
    Write-Host ""
    Write-Host "Creating shortcuts..." -ForegroundColor Cyan
    New-NewsyShortcuts
    Write-Host ""
    Write-Host "Starting it now..."
    Start-ScheduledTask -TaskName $TaskName
    Start-Sleep -Seconds 8
    if (Test-NewsyResponding) {
      Write-Host "Newsy is running at $Url" -ForegroundColor Green
    } else {
      Write-Host "Not responding yet - check 'newsy logs' in a few seconds." -ForegroundColor Yellow
    }
  }

  'tray' {
    Start-Process wscript.exe -ArgumentList "`"$TrayLauncher`"" -WorkingDirectory $ProjectDir
    Start-Sleep -Seconds 3
    $running = Get-Process powershell -ErrorAction SilentlyContinue |
      Where-Object { $_.MainWindowTitle -eq '' }
    Write-Host "Tray icon started - look in the notification area (you may need to" -ForegroundColor Green
    Write-Host "click the ^ arrow, then drag Newsy onto the taskbar to pin it)."
  }

  'shortcut' {
    Write-Host "Creating shortcuts..." -ForegroundColor Cyan
    New-NewsyShortcuts
    Write-Host "Done - double-click Newsy on your desktop." -ForegroundColor Green
  }

  'uninstall' {
    foreach ($lnk in @(
      (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Newsy.lnk'),
      (Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs\Newsy.lnk')
    )) {
      if (Test-Path $lnk) { Remove-Item $lnk -Force; Write-Host "Removed $lnk" }
    }
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
      Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
      Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
      Write-Host "Removed scheduled task '$TaskName'." -ForegroundColor Green
    } else {
      Write-Host "No scheduled task named '$TaskName' was installed."
    }
    Get-NewsyProcess | ForEach-Object {
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
      Write-Host "Stopped running Newsy process (pid $($_.ProcessId))."
    }
    Get-NewsyTray | ForEach-Object {
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
      Write-Host "Stopped tray icon (pid $($_.ProcessId))."
    }
  }

  'start' {
    if (Test-NewsyResponding) { Write-Host "Newsy is already running at $Url"; break }
    # Start the service directly rather than via the task, so `newsy start`
    # does not also spawn a tray icon the user may have dismissed.
    Start-Process wscript.exe -ArgumentList "`"$ServiceOnly`"" -WorkingDirectory $ProjectDir
    Start-Sleep -Seconds 8
    if (Test-NewsyResponding) {
      Write-Host "Newsy is running at $Url" -ForegroundColor Green
    } else {
      Write-Host "Did not come up - check 'newsy logs'." -ForegroundColor Yellow
    }
  }

  'stop' {
    $procs = @(Get-NewsyProcess)
    if ($procs.Count -eq 0) { Write-Host "Newsy is not running."; break }
    foreach ($p in $procs) {
      Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
      Write-Host "Stopped Newsy (pid $($p.ProcessId))." -ForegroundColor Green
    }
    Write-Host "The tray icon stays put and will show 'not running'." -ForegroundColor DarkGray
  }

  'quit' {
    # Everything this project started, and nothing else.
    foreach ($w in @(Get-NewsyWindow)) {
      Stop-Process -Id $w.ProcessId -Force -ErrorAction SilentlyContinue
      Write-Host "Closed app window (pid $($w.ProcessId))."
    }
    foreach ($p in @(Get-NewsyProcess)) {
      Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
      Write-Host "Stopped service (pid $($p.ProcessId))."
    }
    foreach ($t in @(Get-NewsyTray)) {
      Stop-Process -Id $t.ProcessId -Force -ErrorAction SilentlyContinue
      Write-Host "Stopped tray (pid $($t.ProcessId))."
    }
    Write-Host "Newsy is fully shut down. It will start again at your next login;" -ForegroundColor Green
    Write-Host "run 'newsy.cmd uninstall' if you want to stop that too."
  }

  'status' {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    $procs = @(Get-NewsyProcess)

    $cmdPath = Join-Path $ProjectDir 'newsy.cmd'
    Write-Host ""
    Write-Host "Newsy status" -ForegroundColor Cyan
    Write-Host "  Starts at login : $(if ($task) { 'yes' } else { 'no' })"
    Write-Host "  Process running : $(if ($procs.Count) { "yes (pid $($procs[0].ProcessId))" } else { 'no' })"

    if (Test-NewsyResponding) {
      $s = Invoke-RestMethod "$Url/api/state" -TimeoutSec 5
      Write-Host "  Responding      : yes - $Url" -ForegroundColor Green
      Write-Host "  Sources live    : $($s.stats.activeFeeds)/$($s.stats.feeds)"
      Write-Host "  Articles stored : $($s.stats.articles)"
      Write-Host "  Topics          : $($s.stats.topics)"
      Write-Host "  Unread matches  : $($s.stats.unread)"
      # Alerts are raised by whoever holds the event stream. Zero listeners is
      # the silent-failure this line exists to make loud: the service can look
      # perfectly healthy while nothing is announcing a thing.
      $listeners = [int]$s.poller.streams
      if ($listeners -gt 0) {
        Write-Host "  Alert listeners : $listeners"
      } else {
        Write-Host "  Alert listeners : 0 - nothing will be announced" -ForegroundColor Yellow
      }
    } else {
      Write-Host "  Responding      : no" -ForegroundColor Yellow
    }
    if (-not $task) {
      Write-Host ""
      Write-Host "  To start Newsy automatically at login, run:" -ForegroundColor Yellow
      Write-Host "    & `"$cmdPath`" install"
    }
    Write-Host ""
  }

  'logs' {
    if (Test-Path $LogFile) {
      Get-Content $LogFile -Tail $Lines
    } else {
      Write-Host "No log file yet at $LogFile"
    }
  }

  # 'desktop' is an explicit alias for 'open'. Both launch Newsy's own browser;
  # the alias exists because "open" is ambiguous once the app has a browser of
  # its own, and someone looking for the desktop app should find a verb for it.
  { $_ -in 'open', 'desktop' } {
    # Always go through newsy-open.vbs, the same launcher the shortcuts and the
    # tray use, so every entry point behaves identically. Handing the URL to
    # Start-Process would open it as an ordinary tab in the default browser.
    Start-Process wscript.exe -ArgumentList "`"$OpenLauncher`"" -WorkingDirectory $ProjectDir
  }
}
