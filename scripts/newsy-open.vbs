' Opens Newsy: the background service, the tray icon and the app window, in that
' order, starting whichever of the three is not already up. This is what the
' desktop, Start-menu and tray icons point at, so clicking any of them brings up
' the whole of Newsy exactly as logging in does.
'
' Runs windowless: no console flashes on screen.
'
' Newsy opens Newsy's browser. It never launches Chrome — not as a default, not
' as a fallback, not on failure. The Chrome app-mode path that used to live here
' was deleted deliberately: a dormant browser launcher is how a silent fallback
' creeps back in, and falling back to Chrome would hide the very failures worth
' seeing. When the shell cannot start, this says why instead of substituting a
' different browser.

Option Explicit

Dim shell, fso, scriptDir, projectDir, url, port, electron, mainJs, i

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
projectDir = fso.GetParentFolderName(scriptDir)

port = shell.ExpandEnvironmentStrings("%PORT%")
If port = "%PORT%" Or port = "" Then port = "3000"
url = "http://localhost:" & port

electron = projectDir & "\node_modules\electron\dist\electron.exe"
mainJs = projectDir & "\desktop\main.js"

Function IsRunning()
  Dim http
  IsRunning = False
  On Error Resume Next
  Set http = CreateObject("MSXML2.XMLHTTP.6.0")
  http.Open "GET", url & "/api/health", False
  http.Send
  If Err.Number = 0 Then IsRunning = (http.Status = 200)
  On Error GoTo 0
End Function

' The shell is only a window onto the service, so make sure the service is up
' first. The shell shows its own "not answering" card if this does not succeed.
If Not IsRunning() Then
  shell.Run Chr(34) & scriptDir & "\newsy-hidden.vbs" & Chr(34), 0, False
  For i = 1 To 40
    WScript.Sleep 500
    If IsRunning() Then Exit For
  Next
End If

' The tray icon, the third of Newsy's three processes. Started here so that
' clicking the icon brings up everything the logon task does -- service, tray
' and shell -- rather than leaving the tray to be started by hand. It is fired
' unconditionally: newsy-tray.ps1 holds a named mutex and a second copy exits
' immediately, so any number of clicks still yields one icon.
'
' Started before the checks below, not after: if the shell is missing or broken,
' the tray is the only interface left, and its menu can still start and stop the
' service and open the log.
shell.Run Chr(34) & scriptDir & "\newsy-tray-hidden.vbs" & Chr(34), 0, False

' Fail loudly and specifically. Every message names the fix.
If Not fso.FileExists(mainJs) Then
  MsgBox "Newsy's desktop files are missing:" & vbCrLf & vbCrLf & _
         mainJs & vbCrLf & vbCrLf & _
         "The project folder may have moved or be incomplete.", _
         vbCritical, "Newsy"
  WScript.Quit 1
End If

If Not fso.FileExists(electron) Then
  MsgBox "Newsy's browser is not installed yet." & vbCrLf & vbCrLf & _
         "Electron is missing from node_modules. Open a terminal in:" & vbCrLf & _
         projectDir & vbCrLf & vbCrLf & _
         "and run:  npm install" & vbCrLf & vbCrLf & _
         "(The dashboard is still reachable at " & url & _
         " in any browser meanwhile.)", _
         vbCritical, "Newsy"
  WScript.Quit 1
End If

' Electron holds a single-instance lock: a second launch focuses the existing
' window and exits immediately, which is correct and needs no handling here.
'
' Window style is 1 (SW_SHOWNORMAL), NOT the 0 every other Newsy .vbs uses. The 0
' in the others means "this is a console program, hide its console"; here it means
' "hide the app", and it did: the process started fine but came up with no window
' handle at all, which is what made the desktop icon look like it did nothing.
' Electron is a GUI program and has no console to suppress, so there is nothing
' for a 0 to buy here.
On Error Resume Next
shell.Run Chr(34) & electron & Chr(34) & " " & Chr(34) & mainJs & Chr(34), 1, False
If Err.Number <> 0 Then
  MsgBox "Newsy's browser could not start." & vbCrLf & vbCrLf & _
         "Error " & Err.Number & ": " & Err.Description & vbCrLf & vbCrLf & _
         "If your antivirus quarantined electron.exe, restore it or run" & vbCrLf & _
         "npm install to fetch it again." & vbCrLf & vbCrLf & _
         "(The dashboard is still reachable at " & url & " in any browser.)", _
         vbCritical, "Newsy"
  WScript.Quit 1
End If
On Error GoTo 0
