@echo off
chcp 65001 >nul
title Meeting Copilot 원클릭 간편 설치 및 실행기

echo ========================================================
echo        Meeting Copilot 원클릭 환경 설정 및 실행기
echo ========================================================
echo.

:: 1. Python 설치 확인 및 자동 설치
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [!] Python이 감지되지 않았습니다.
    echo [*] 윈도우 패키지 관리자(winget)로 Python 3.12 자동 설치를 진행합니다...
    winget install Python.Python.3.12 --silent --accept-source-agreements --accept-package-agreements
    if %errorlevel% neq 0 (
        echo [안내] 자동 설치에 실패했습니다. https://www.python.org 에서 설치해 주세요.
        pause
        exit /b
    )
    echo [V] Python 설치 완료!
) else (
    echo [V] Python 확인 완료.
)

:: 2. Node.js (npx kordoc용) 설치 확인 및 자동 설치
npx --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [!] Node.js가 감지되지 않았습니다. (윤주무관 kordoc 파서 구동용)
    echo [*] 윈도우 패키지 관리자(winget)로 Node.js LTS 자동 설치를 진행합니다...
    winget install OpenJS.NodeJS.LTS --silent --accept-source-agreements --accept-package-agreements
    if %errorlevel% neq 0 (
        echo [안내] 자동 설치에 실패했습니다. https://nodejs.org 에서 설치해 주세요.
        pause
        exit /b
    )
    echo [V] Node.js 설치 완료!
) else (
    echo [V] Node.js 확인 완료.
)

:: 3. 바탕화면에 [Meeting Copilot] 바로가기 생성
echo [*] 바탕화면에 [Meeting Copilot] 바로가기 아이콘을 생성합니다...
wscript.exe "%~dp0create_shortcut.vbs"
echo [V] 바탕화면 바로가기 생성 완료!

echo.
echo ========================================================
echo   축하합니다! 모든 설정이 완료되었습니다.
echo   미팅앱 서버 및 브라우저를 지금 즉시 시작합니다!
echo ========================================================
echo.
wscript.exe "%~dp0run_kordoc_background.vbs"
timeout /t 3 >nul
