@echo off
REM Newsy control script.
REM
REM   newsy install     start automatically at login, in the background
REM   newsy uninstall   stop doing that
REM   newsy start       start it now
REM   newsy stop        stop it
REM   newsy status      is it running, and what has it collected
REM   newsy logs        last 40 log lines
REM   newsy open        open Newsy in its own browser
REM   newsy desktop     the same thing, named for what it is
REM
REM -ExecutionPolicy Bypass is what lets this work without changing any
REM machine-wide PowerShell setting.

setlocal
set "SCRIPT=%~dp0scripts\newsy-service.ps1"

if "%~1"=="" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" status
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
)

endlocal
