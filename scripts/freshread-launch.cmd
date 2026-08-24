@echo off
setlocal EnableExtensions DisableDelayedExpansion

if not defined PLUGIN_ROOT goto :launcher_failed
if not defined SystemRoot goto :launcher_failed

for %%I in ("%~dp0.") do set "FRESHREAD_SCRIPT_DIR=%%~fI"
set "FRESHREAD_HOOK=%FRESHREAD_SCRIPT_DIR%\freshread-hook.cjs"
set "FRESHREAD_DISCOVERY=%FRESHREAD_SCRIPT_DIR%\freshread-node-path.js"
set "FRESHREAD_POWERSHELL=%FRESHREAD_SCRIPT_DIR%\freshread-launch.ps1"

if not exist "%FRESHREAD_HOOK%" goto :launcher_failed
if not exist "%FRESHREAD_DISCOVERY%" goto :launcher_failed
if not exist "%FRESHREAD_POWERSHELL%" goto :launcher_failed
if not exist "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" goto :launcher_failed

rem Fast path: a fixed Windows Script Host process returns a vetted Node path
rem or an explicit security/compatibility decision. An explicit security
rem refusal must never be retried by the less restrictive compatibility path.
set "FRESHREAD_DISCOVERY_RESULT="
for /f "usebackq delims=" %%N in (`%SystemRoot%\System32\cscript.exe //B //Nologo "%FRESHREAD_DISCOVERY%" 2^>nul`) do if not defined FRESHREAD_DISCOVERY_RESULT set "FRESHREAD_DISCOVERY_RESULT=%%N"

if not defined FRESHREAD_DISCOVERY_RESULT goto :compatibility_fallback
if /i "%FRESHREAD_DISCOVERY_RESULT%"=="__FRESHREAD_DISCOVERY_DENY__" goto :discovery_denied
if /i "%FRESHREAD_DISCOVERY_RESULT%"=="__FRESHREAD_DISCOVERY_FALLBACK__" goto :compatibility_fallback
set "FRESHREAD_NODE=%FRESHREAD_DISCOVERY_RESULT%"
if exist "%FRESHREAD_NODE%" goto :run_node
goto :discovery_denied

rem Compatibility/security fallback for uncommon path layouts. It resolves
rem reparse targets component by component and also preserves hook stdio.
:compatibility_fallback
set "FRESHREAD_POWERSHELL_FALLBACK=1"
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%FRESHREAD_POWERSHELL%"
exit /b %errorlevel%

:run_node
"%FRESHREAD_NODE%" "%FRESHREAD_HOOK%"
exit /b %errorlevel%

:discovery_denied
1>&2 echo FreshRead launcher failed: Node discovery rejected an unsafe or unavailable execution path
exit /b 2

:launcher_failed
1>&2 echo FreshRead launcher failed: required launcher state is unavailable
exit /b 2
