' What the logon scheduled task runs.
'
' Starts the background service, the tray icon and the alert shell as three
' independent processes, deliberately: if one fails to start, the others must
' carry on regardless.

Option Explicit

Dim shell, fso, scriptDir, projectDir, electron, mainJs

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
projectDir = fso.GetParentFolderName(scriptDir)
shell.CurrentDirectory = projectDir

shell.Run "wscript.exe " & Chr(34) & fso.BuildPath(scriptDir, "newsy-hidden.vbs") & Chr(34), 0, False

' Let the service bind its port before the tray asks it for status, so the first
' tooltip after logon is not a misleading "not running".
WScript.Sleep 4000

shell.Run "wscript.exe " & Chr(34) & fso.BuildPath(scriptDir, "newsy-tray-hidden.vbs") & Chr(34), 0, False

' The alert shell. Newsy's notifications are raised by this process from the
' service's event stream, so without it running nothing is ever announced — the
' service goes on collecting and matching in silence. It is started windowless
' via --hidden: alerting from logon, but no window thrown at you while you are
' doing something else. Opening Newsy later attaches to this same instance.
'
' Window style is 1, NOT the 0 used above. The 0 elsewhere means "this is a
' console program, hide its console". Electron has no console, and passing 0
' here would hand it an SW_HIDE hint that the first window it creates can
' inherit -- which is exactly the "starts but has no window" bug that made the
' desktop icon look dead. --hidden is what suppresses the window; the style is
' not, and must not be asked to.
electron = projectDir & "\node_modules\electron\dist\electron.exe"
mainJs = projectDir & "\desktop\main.js"

If fso.FileExists(electron) And fso.FileExists(mainJs) Then
  On Error Resume Next
  shell.Run Chr(34) & electron & Chr(34) & " " & Chr(34) & mainJs & Chr(34) & " --hidden", 1, False
  On Error GoTo 0
End If
