@echo off
cd /d "%~dp0"
echo Installing dependencies...
"D:\Program Files (x86)\Microsoft Visual Studio\Shared\Python39_64\python.exe" -m pip install -r requirements.txt -q
echo.
echo Starting translator proxy server on http://localhost:8000
echo Press Ctrl+C to stop
echo.
"D:\Program Files (x86)\Microsoft Visual Studio\Shared\Python39_64\python.exe" -m uvicorn main:app --host 0.0.0.0 --port 8000 --reload
