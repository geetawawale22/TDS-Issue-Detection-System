@echo off
REM Start the TDS backend on the client laptop (Windows) and keep it running.
REM
REM  * No --reload: reload mode restarts the server whenever a .py file changes
REM    (e.g. after a git pull) and on Windows sometimes does not come back.
REM  * If the backend stops for any reason, it is started again after 5 seconds.
REM  * This window shows every request, as plain uvicorn does.
REM  * logs\backend.log keeps only errors, warnings and failed API calls (status
REM    400+), plus a line each time the backend starts or stops with its exit
REM    code. It is capped at 5 MB; older entries move to backend.log.1 ... .5,
REM    so the logs never take more than about 30 MB. See log_config.json.
REM
REM Run it from anywhere: double-click, or  backend\start_backend.bat
REM Stop it: close this window (or press Ctrl+C twice).

cd /d "%~dp0"
if not exist logs mkdir logs

set PYTHON=
if exist ".venv\Scripts\python.exe" set PYTHON=.venv\Scripts\python.exe
if not defined PYTHON if exist "venv\Scripts\python.exe" set PYTHON=venv\Scripts\python.exe
if not defined PYTHON if exist "..\venv\Scripts\python.exe" set PYTHON=..\venv\Scripts\python.exe
if not defined PYTHON if exist "..\.venv\Scripts\python.exe" set PYTHON=..\.venv\Scripts\python.exe
if not defined PYTHON (
  echo No virtual environment found ^(.venv or venv in backend or the project folder^).
  pause
  exit /b 1
)

:start
echo [%date% %time%] Starting backend with %PYTHON% >> logs\backend.log
echo Backend starting on http://localhost:8000  -  errors are also saved in %~dp0logs\backend.log
"%PYTHON%" -m uvicorn main:app --host 0.0.0.0 --port 8000 --log-config log_config.json
set EXITCODE=%errorlevel%
echo [%date% %time%] Backend STOPPED, exit code %EXITCODE% >> logs\backend.log
echo [%date% %time%] Backend stopped (exit code %EXITCODE%), restarting in 5 seconds...
timeout /t 5 /nobreak >nul
goto start
