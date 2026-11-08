@echo off
setlocal
chcp 65001 >nul

rem Установка плагина в глобальный каталог OpenCode:
rem   %USERPROFILE%\.config\opencode\plugins\go-cost\
rem Это каталог глобальных плагинов OpenCode V2 (и серверных, и TUI).
rem Если задан XDG_CONFIG_HOME, он используется вместо %USERPROFILE%\.config.
rem
rem Плагин подменяет общий метод context.data.session.cost, поэтому оценка
rem появляется на месте встроенной стоимости, и добавляет в правую панель
rem лимиты OpenCode Go. Конфиги (cli.json, opencode.json) не меняются.

set "SRC=%~dp0plugin"
set "CONFIG_DIR=%USERPROFILE%\.config\opencode"
if not "%XDG_CONFIG_HOME%"=="" set "CONFIG_DIR=%XDG_CONFIG_HOME%\opencode"
set "DST=%CONFIG_DIR%\plugins\go-cost"

if not exist "%SRC%\tui.tsx" (
  echo [ERROR] Не найден "%SRC%\tui.tsx". Запусти install.bat из корня репозитория.
  pause
  exit /b 1
)

if not exist "%DST%" mkdir "%DST%"

for %%F in (index.js cost.js patch.js usage.js tui.tsx package.json) do (
  if exist "%SRC%\%%F" xcopy "%SRC%\%%F" "%DST%\" /Y >nul
)

echo [OK] Плагин установлен в: %DST%
echo.
echo Каталог plugins\^<имя^> подхватывается автоматически, править cli.json
echo и opencode.json не нужно.
echo.
echo После установки перезапусти сервис: opencode service restart
echo и заново открой OpenCode (TUI подхватывает плагин при запуске).
echo.
echo Проверка: в сессии OpenCode Go с ненулевыми токенами стоимость появится
echo на месте встроенной, рядом со счётчиком токенов: "470.3K (48%) · $0.17".
echo В правой панели появится блок "OpenCode Go" с лимитами 5h/weekly/monthly.
echo.

pause
