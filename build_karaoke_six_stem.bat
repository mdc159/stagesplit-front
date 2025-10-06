@echo off
setlocal enabledelayedexpansion

REM ----------------------------------------------
REM  Find first MP4 in current directory
REM ----------------------------------------------
for %%F in (*.mp4) do (
    set "VIDEOFILE=%%F"
    goto found
)
:found

if not defined VIDEOFILE (
    echo No MP4 file found in this folder.
    pause
    exit /b
)

REM ----------------------------------------------
REM  Extract base name (without extension)
REM ----------------------------------------------
for %%A in ("%VIDEOFILE%") do set "BASENAME=%%~nA"
set "OUTPUT=%BASENAME% (karaoke_six_stem).mp4"

echo ---------------------------------------------
echo Building karaoke container from:
echo   Video: "%VIDEOFILE%"
echo   Output: "%OUTPUT%"
echo ---------------------------------------------

REM ----------------------------------------------
REM  Check all required stems exist
REM ----------------------------------------------
set missing=0
for %%S in (vocals drums bass guitar piano other) do (
    if not exist "%%S.wav" (
        echo Missing: %%S.wav
        set /a missing+=1
    )
)
if !missing! gtr 0 (
    echo ---------------------------------------------
    echo One or more stem files are missing.
    echo Please verify all six WAVs are in this folder.
    echo ---------------------------------------------
    pause
    exit /b
)

REM ----------------------------------------------
REM  Combine stems into final MP4
REM ----------------------------------------------
ffmpeg -hide_banner -y ^
  -i "%VIDEOFILE%" ^
  -i vocals.wav ^
  -i drums.wav ^
  -i bass.wav ^
  -i guitar.wav ^
  -i piano.wav ^
  -i other.wav ^
  -map 0:v ^
  -map 1:a -metadata:s:a:0 handler_name="Vocals" ^
  -map 2:a -metadata:s:a:1 handler_name="Drums" ^
  -map 3:a -metadata:s:a:2 handler_name="Bass" ^
  -map 4:a -metadata:s:a:3 handler_name="Guitar" ^
  -map 5:a -metadata:s:a:4 handler_name="Piano" ^
  -map 6:a -metadata:s:a:5 handler_name="Ambience" ^
  -c:v copy -c:a aac -b:a 256k -movflags +faststart ^
  -disposition:a:0 none ^
  "%OUTPUT%"



if %errorlevel% neq 0 (
  echo ---------------------------------------------
  echo ❌ Error: FFmpeg failed.
  echo ---------------------------------------------
  pause
  exit /b
)

echo ---------------------------------------------
echo ✅ Done!
echo Output file created:
echo   "%OUTPUT%"
echo ---------------------------------------------
pause
