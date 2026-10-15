@echo off
chcp 65001 >nul
title Lancement de l'experience

REM ================================================================
REM  Ouvre l'experience dans une NOUVELLE fenetre Google Chrome.
REM  A placer dans le meme dossier que index.html, puis double-cliquer.
REM ================================================================

set /p PID=Numero du participant (meme numero que dans LimeSurvey) :

if "%PID%"=="" (
  echo Aucun numero saisi. Fermeture.
  pause
  exit /b
)

REM Chemin du dossier ou se trouve ce fichier (donc index.html)
set "DOSSIER=%~dp0"
set "DOSSIER=%DOSSIER:\=/%"

start "" chrome --new-window "file:///%DOSSIER%index.html?participant=%PID%"

if errorlevel 1 (
  echo.
  echo Chrome n'a pas pu etre lance automatiquement.
  echo Ouvrez Chrome et collez cette adresse :
  echo file:///%DOSSIER%index.html?participant=%PID%
  pause
)
