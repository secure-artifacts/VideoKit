@echo off
cd /d "%~dp0"
echo ==============================
echo Facebook 视频批量下载开始
echo ==============================

yt-dlp.exe --batch-file "links.txt" --ignore-errors ^
-f "bv*+ba/b" ^
--windows-filenames ^
--restrict-filenames ^
--trim-filenames 120 ^
-o "%%(id)s.%%(ext)s"

echo.
echo ==============================
echo 下载完成，按任意键关闭
echo ==============================
pause
