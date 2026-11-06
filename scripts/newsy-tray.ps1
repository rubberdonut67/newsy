<#
.SYNOPSIS
  Newsy system tray icon.

.DESCRIPTION
  Puts Newsy in the notification area with a live unread count and a right-click
  menu. Uses Windows Forms' NotifyIcon, which ships with Windows — no extra
  dependency, and nothing to compile.

  Launch it windowless via newsy-tray-hidden.vbs, or with: newsy.cmd tray
#>
param(
  [switch]$NoServiceStart
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$ProjectDir = Split-Path -Parent $PSScriptRoot
$IconPath   = Join-Path $ProjectDir 'public\newsy.ico'
# Follows the movable data folder, same as newsy-service.ps1. The tray writes
# here at startup, so a stale path would mean a log nobody ever finds.
$TrayDataDir = Join-Path $ProjectDir 'data'
if ($env:DATA_DIR) {
  $TrayDataDir = $env:DATA_DIR
} else {
  $trayLocationFile = Join-Path $ProjectDir 'data-location.json'
  if (Test-Path $trayLocationFile) {
    try {
      $trayChosen = (Get-Content $trayLocationFile -Raw | ConvertFrom-Json).dataDir
      if ($trayChosen) { $TrayDataDir = $trayChosen }
    } catch {
      # Unreadable: the default below still works.
    }
  }
}
if (-not (Test-Path $TrayDataDir)) { New-Item -ItemType Directory -Path $TrayDataDir -Force | Out-Null }
$LogFile    = Join-Path $TrayDataDir 'newsy-tray.log'
$OpenVbs    = Join-Path $PSScriptRoot 'newsy-open.vbs'
$StartVbs   = Join-Path $PSScriptRoot 'newsy-hidden.vbs'
$Port       = if ($env:PORT) { $env:PORT } else { 3000 }
$Url        = "http://localhost:$Port"

function Write-TrayLog([string]$message) {
  try {
    $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    Add-Content -Path $LogFile -Value "$stamp $message" -Encoding utf8
  } catch { }
}

# Only one tray icon, however many times the shortcut is clicked.
$mutex = New-Object System.Threading.Mutex($false, 'Local\NewsyTrayIcon')
if (-not $mutex.WaitOne(0, $false)) {
  Write-TrayLog 'tray already running, exiting'
  return
}

function Get-NewsyState {
  try {
    return Invoke-RestMethod "$Url/api/state" -TimeoutSec 4
  } catch {
    return $null
  }
}

function Start-NewsyService {
  Start-Process wscript.exe -ArgumentList "`"$StartVbs`"" -WorkingDirectory $ProjectDir
}

# The global alert mute, held by the service. Menu click handlers are
# scriptblocks with their own scope, so everything they read or write here has
# to be script-scoped or the assignment lands in a scope that dies with the click.
$script:MuteState = [pscustomobject]@{ muted = $false; mutedUntil = $null; scope = 'toasts' }

function Test-Muted {
  # The deadline is re-checked locally rather than trusted from the last poll,
  # so a mute cannot appear to outlive the moment the user chose for it.
  if (-not $script:MuteState.muted) { return $false }
  if ($null -eq $script:MuteState.mutedUntil) { return $true }
  return [System.DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -lt [long]$script:MuteState.mutedUntil
}

function Set-Mute([bool]$muted, $minutes) {
  $body = @{ muted = $muted }
  if ($muted -and $minutes -gt 0) { $body.minutes = $minutes }
  try {
    # -ContentType and -Body are load-bearing here for the same reason they are
    # on /api/refresh below: without them this posts form-encoded and gets a 415.
    $script:MuteState = Invoke-RestMethod "$Url/api/alerts" -Method Patch `
      -ContentType 'application/json' -Body ($body | ConvertTo-Json -Compress) -TimeoutSec 10
    Update-Tray
    Write-TrayLog "mute set to $muted$(if ($minutes -gt 0) { " for $minutes min" })"
  } catch {
    Show-Balloon 'Newsy' "Could not change alerts: $($_.Exception.Message)" 'Warning' -Force
  }
}

<#
.SYNOPSIS
  Balloon tips, gated by the mute's scope.
.DESCRIPTION
  Scope 'toasts' mutes only the Windows notifications the shell raises; scope
  'all' takes these tray messages with it. -Force exempts a message reporting
  the failure of something the user just asked for: muting the news is not the
  same as being told nothing when a button does not work.
#>
function Show-Balloon([string]$title, [string]$text, [string]$icon, [switch]$Force) {
  if (-not $Force -and (Test-Muted) -and $script:MuteState.scope -eq 'all') {
    Write-TrayLog "balloon suppressed while muted: $text"
    return
  }
  $notify.ShowBalloonTip(3000, $title, $text, $icon)
}

function Stop-NewsyService {
  # Scope the match to THIS project directory. Sibling projects share the
  # src/index.ts layout, and matching on that alone would kill unrelated apps.
  $dir = [regex]::Escape($ProjectDir)
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
    Where-Object {
      $_.CommandLine -and $_.CommandLine -match $dir -and $_.CommandLine -match 'src[\\/]index\.ts'
    } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

function Close-NewsyWindow {
  # Two shapes of app window: the Electron shell (default since 21 Aug 2026) and
  # the older Chrome/Edge app-mode window, still supported. Closing only the
  # Chrome one left the shell running after Quit -- it looked like Quit had
  # failed. Only the Electron *main* process carries desktop\main.js; its
  # --type= children exit with it. The project-directory match is what keeps a
  # sibling project's Electron app out of the net.
  $dir = [regex]::Escape($ProjectDir)

  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue -Filter "Name = 'electron.exe'" |
    Where-Object {
      $_.CommandLine -and
      $_.CommandLine -match $dir -and
      $_.CommandLine -match 'desktop[\\/]main\.js'
    } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue -Filter "Name = 'chrome.exe' OR Name = 'msedge.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine -match "--app=http://localhost:$Port(\s|$)" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

if (-not $NoServiceStart -and -not (Get-NewsyState)) {
  Write-TrayLog 'service not responding at startup, starting it'
  Start-NewsyService
}

# --- Tray icon ---------------------------------------------------------------

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = New-Object System.Drawing.Icon($IconPath)
$notify.Text = 'Newsy'
$notify.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip

$miStatus = $menu.Items.Add('Starting...')
$miStatus.Enabled = $false
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

$miOpen = $menu.Items.Add('Open Newsy')
$miOpen.Font = New-Object System.Drawing.Font($menu.Font, [System.Drawing.FontStyle]::Bold)
$miOpen.add_Click({
  Start-Process wscript.exe -ArgumentList "`"$OpenVbs`"" -WorkingDirectory $ProjectDir
})

$miRefresh = $menu.Items.Add('Check for news now')
$miRefresh.add_Click({
  try {
    # `-ContentType`/`-Body` are load-bearing. Invoke-RestMethod with -Method Post
    # and no body defaults to application/x-www-form-urlencoded, which this JSON
    # API rejects outright — so this menu item returned 415 and had never once
    # worked. The dashboard's Refresh button sends no content-type at all and is
    # accepted, which is why the bug hid here.
    $null = Invoke-RestMethod "$Url/api/refresh" -Method Post -ContentType 'application/json' -Body '{}' -TimeoutSec 120
    Show-Balloon 'Newsy' 'Finished checking every source.' 'Info'
  } catch {
    # -Force: a refresh the user pressed and that failed must still speak, even
    # under the wider mute. Silencing the news is not silencing an error report.
    Show-Balloon 'Newsy' "Could not refresh: $($_.Exception.Message)" 'Warning' -Force
  }
})

# Mute, not disarm. The service holds the state and the shell does the actual
# suppressing; this item only records the choice, which is why `.Checked` is set
# from Update-Tray and never by CheckOnClick — the menu must not show a state the
# service has not accepted.
$miMute = $menu.Items.Add('Mute alerts')
$miMute.add_Click({ Set-Mute (-not (Test-Muted)) 0 })

$miMuteFor = New-Object System.Windows.Forms.ToolStripMenuItem 'Mute alerts for'
foreach ($span in @(
  @{ Label = '30 minutes'; Minutes = 30 },
  @{ Label = '2 hours';    Minutes = 120 },
  @{ Label = '8 hours';    Minutes = 480 }
)) {
  # GetNewClosure: without it every handler would capture the *last* $span, and
  # all three items would mute for eight hours.
  $minutes = $span.Minutes
  $item = $miMuteFor.DropDownItems.Add($span.Label)
  $item.add_Click({ Set-Mute $true $minutes }.GetNewClosure())
}
[void]$menu.Items.Add($miMuteFor)

[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

$miStart = $menu.Items.Add('Start background service')
$miStart.add_Click({ Start-NewsyService })

$miStop = $menu.Items.Add('Stop background service')
$miStop.add_Click({
  Stop-NewsyService
  Show-Balloon 'Newsy' 'Background service stopped. Alerts are off.' 'Info'
})

$miLogs = $menu.Items.Add('View log')
$miLogs.add_Click({
  # $TrayDataDir, not the project folder: the data directory is movable from the
  # Developer tab, and a hardcoded path opens nothing once it has moved.
  $log = Join-Path $TrayDataDir 'newsy.log'
  if (Test-Path $log) { Start-Process notepad.exe $log }
  else { Show-Balloon 'Newsy' "No log yet at $log" 'Info' }
})

[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

$miQuit = $menu.Items.Add('Quit Newsy (stop everything)')
$miQuit.add_Click({
  # Order matters: take the icon out of the tray first, so the notification area
  # never shows a ghost icon while the rest is shutting down.
  $notify.Visible = $false
  Close-NewsyWindow
  Stop-NewsyService
  Write-TrayLog 'quit: service stopped, window closed, tray exiting'
  [System.Windows.Forms.Application]::Exit()
})

$miHide = $menu.Items.Add('Hide tray icon only')
# Deliberately leaves the service running: hiding an icon must not silently
# switch off the alerts the app exists to deliver.
$miHide.add_Click({
  $notify.Visible = $false
  Write-TrayLog 'tray hidden, service left running'
  [System.Windows.Forms.Application]::Exit()
})

$notify.ContextMenuStrip = $menu
$notify.add_MouseDoubleClick({
  Start-Process wscript.exe -ArgumentList "`"$OpenVbs`"" -WorkingDirectory $ProjectDir
})

# --- Live status -------------------------------------------------------------

function Update-Tray {
  $state = Get-NewsyState

  if (-not $state) {
    # NotifyIcon.Text is capped at 63 characters, so keep these terse.
    $notify.Text = 'Newsy - not running'
    $miStatus.Text = 'Not running'
    $miStart.Enabled = $true
    $miStop.Enabled = $false
    $miRefresh.Enabled = $false
    $miMute.Enabled = $false
    $miMuteFor.Enabled = $false
    return
  }

  if ($state.alerts) { $script:MuteState = $state.alerts }
  $muted = Test-Muted
  $miMute.Checked = $muted
  $miMute.Text = if ($muted) { 'Muted — turn alerts back on' } else { 'Mute alerts' }
  $miMute.Enabled = $true
  # Left enabled while muted on purpose: picking a duration during a mute resets
  # the clock, which is what someone extending a mute expects. Disabling it would
  # force an unmute-then-remute, and the gap between those is a toast.
  $miMuteFor.Enabled = $true

  $unread = [int]$state.stats.unread

  # Alerts are raised by the shell holding the event stream, so no listener means
  # no notifications -- while collecting and matching carry on looking perfectly
  # healthy. That combination went unnoticed for a day; say it on the tooltip,
  # which is the only surface visible when the window is closed.
  $listeners = [int]$state.poller.streams

  # Muted outranks the listener check, and the wording matters. 'alerts off' has
  # always meant *broken* here, so a mute borrowing it would make the tray cry
  # wolf on a day the user simply asked for quiet.
  if ($muted) {
    $until = if ($null -eq $script:MuteState.mutedUntil) {
      ''
    } else {
      ' until ' + ([datetimeoffset]::FromUnixTimeMilliseconds([long]$script:MuteState.mutedUntil)).LocalDateTime.ToString('h:mm tt')
    }
    # NotifyIcon.Text is capped at 63 characters; this stays well inside it.
    $notify.Text = "Newsy - muted$until"
  } elseif ($listeners -le 0) {
    $notify.Text = 'Newsy - alerts off'
  } elseif ($unread -gt 0) {
    $notify.Text = "Newsy - $unread unread"
  } else {
    $notify.Text = 'Newsy - up to date'
  }

  $alerts = if ($muted) { 'muted' } elseif ($listeners -gt 0) { 'alerts on' } else { 'ALERTS OFF' }
  $miStatus.Text = "$unread unread | $alerts | $($state.stats.activeFeeds)/$($state.stats.feeds) sources"
  $miStart.Enabled = $false
  $miStop.Enabled = $true
  $miRefresh.Enabled = $true
}

Update-Tray

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 30000
$timer.add_Tick({ Update-Tray })
$timer.Start()

# Refresh the moment the menu opens, so it never shows a stale count.
$menu.add_Opening({ Update-Tray })

Write-TrayLog 'tray started'

try {
  [System.Windows.Forms.Application]::Run((New-Object System.Windows.Forms.ApplicationContext))
} finally {
  $timer.Stop()
  $notify.Visible = $false
  $notify.Dispose()
  $mutex.ReleaseMutex()
  Write-TrayLog 'tray exited'
}
