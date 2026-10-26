@echo off
rem starnet - the StarNet command line. Installed with the desktop app it runs on the app's own node.exe (one folder
rem up); from a checkout it runs on node from PATH. Every argument passes through; the exit code is the CLI's own.
if exist "%~dp0..\node.exe" (
  "%~dp0..\node.exe" "%~dp0starnet.js" %*
) else (
  node "%~dp0starnet.js" %*
)
exit /b %ERRORLEVEL%
