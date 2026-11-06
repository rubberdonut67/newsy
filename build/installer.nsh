; Extra steps for Newsy's NSIS installer (electron-builder includes this file).
;
; The "Start Newsy when I sign in" setting lives in the per-user Run key, written
; by the app itself (app.setLoginItemSettings, value name "Newsy"). Uninstalling
; must remove it, or Windows keeps trying to start an app that is gone.
; The user's articles and settings in %APPDATA%\Newsy are deliberately kept.
!macro customUnInstall
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Newsy"
!macroend
