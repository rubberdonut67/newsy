' Launches Newsy with no console window.
'
' Node has no windowless host the way Python has pythonw.exe, so starting
' node.exe directly from Task Scheduler flashes (or keeps) a console window.
' WScript.Shell's Run with intWindowStyle 0 starts it fully hidden.
'
' Usage: wscript.exe newsy-hidden.vbs
' All output goes to data\newsy.log, since there is no console to read.

Option Explicit

Dim shell, fso, scriptDir, projectDir, command
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
projectDir = fso.GetParentFolderName(scriptDir)

shell.CurrentDirectory = projectDir

' --env-file-if-exists is what makes a .env file in the project root actually do
' something. Without it .env is a file the app never reads, which is worse than
' not having one: .env.example invites you to copy it, and the settings inside
' would silently have no effect. "if-exists" rather than plain --env-file so a
' missing .env is not a failure to start.
'
' Real environment variables still win over anything in the file, so setting a
' value at the machine or task level continues to override it.
command = "node.exe --disable-warning=ExperimentalWarning " & _
          "--env-file-if-exists=" & Chr(34) & fso.BuildPath(projectDir, ".env") & Chr(34) & " " & _
          Chr(34) & fso.BuildPath(projectDir, "src\index.ts") & Chr(34)

' 0 = hidden window, False = do not wait for it to exit.
shell.Run command, 0, False
