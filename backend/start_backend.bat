@echo off
REM Start the TDS backend on the client laptop (Windows) and keep it running.
REM
REM  * No --reload: reload mode restarts the server whenever a .py file changes
REM    (e.g. after a git pull) and on Windows sometimes does not come back.
REM  * If the backend stops for any reason, it is started again after 5 seconds.
REM  * Everything it prints goes to logs\backend.log, with a line saying when it
REM    stopped and its exit code, so the reason can be read afterwards.
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
echo Backend running on http://localhost:8000  -  log: %~dp0logs\backend.log
"%PYTHON%" -m uvicorn main:app --host 0.0.0.0 --port 8000 >> logs\backend.log 2>&1
echo [%date% %time%] Backend STOPPED, exit code %errorlevel% >> logs\backend.log
echo [%date% %time%] Backend stopped (exit code %errorlevel%), restarting in 5 seconds...
timeout /t 5 /nobreak >nul
goto start
