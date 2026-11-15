@echo off
title Subir Kraken Cloud a GitHub - Castillo Imperial
cd /d "C:\Users\franc\antigravity\kraken-cloud"
set "PATH=C:\Users\franc\AppData\Local\Microsoft\WinGet\Packages\Git.MinGit_Microsoft.Winget.Source_8wekyb3d8bbwe\cmd;%PATH%"
echo ================================================================
echo   CASTILLO IMPERIAL HOLDING - KRAKEN QUANT CLOUD PUSH
echo   Repositorio: https://github.com/pecas89/kraken-cloud
echo ================================================================
echo.
echo Subiendo rama main a GitHub...
git push -u origin main
if %ERRORLEVEL% EQU 0 (
    echo.
    echo ================================================================
    echo   EXITO: Codigo subido correctamente a GitHub.
    echo ================================================================
) else (
    echo.
    echo Si te pide usuario y contrasena:
    echo En GitHub la contrasena es un Personal Access Token (PAT).
)
echo.
pause
