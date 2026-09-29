@echo off
title Merc Scheduling Bot
cd /d "%~dp0"

rem ---- Check that Node.js is installed ----
where node >nul 2>nul
if errorlevel 1 (
    echo Node.js is not installed or not on your PATH.
    echo Download it from https://nodejs.org ^(LTS version^), install it, then run this again.
    echo.
    pause
    exit /b 1
)

rem ---- Create .env from the example on first run ----
if not exist ".env" (
    copy ".env.example" ".env" >nul
    echo Created a .env file for you.
    echo Open .env in Notepad, paste your bot token after DISCORD_TOKEN=, save, then run this again.
    echo.
    start "" notepad ".env"
    pause
    exit /b 1
)

rem ---- Make sure a token has been filled in ----
findstr /r /c:"^DISCORD_TOKEN=..*" ".env" >nul
if errorlevel 1 (
    echo You haven't added your token yet.
    echo Open .env, paste your bot token after DISCORD_TOKEN=, save, then run this again.
    echo.
    start "" notepad ".env"
    pause
    exit /b 1
)

rem ---- Install dependencies the first time (or if node_modules was deleted) ----
if not exist "node_modules\" (
    echo Installing dependencies, this only happens once...
    call npm install
    if errorlevel 1 (
        echo.
        echo npm install failed. Scroll up to see why.
        pause
        exit /b 1
    )
)

echo Starting the bot. Close this window or press Ctrl+C to stop it.
echo.
call npm start

echo.
echo The bot has stopped. Scroll up to see why.
pause
