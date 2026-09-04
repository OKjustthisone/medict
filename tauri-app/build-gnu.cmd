@echo off
setlocal EnableExtensions

set "TARGET=x86_64-pc-windows-gnu"
set "TOOLCHAIN=stable-x86_64-pc-windows-gnu"
rem Use an 8.3 path so MinGW windres can handle this checkout's parent folder.
set "PROJECT_DIR=%~sdp0"
set "REPO_DIR=%PROJECT_DIR%.."

if defined MEDICT_MINGW_ROOT (
    set "MINGW_ROOT=%MEDICT_MINGW_ROOT%"
) else (
    set "MINGW_ROOT=%USERPROFILE%\.w64devkit"
)
set "MINGW_BIN=%MINGW_ROOT%\bin"

if not exist "%MINGW_BIN%\gcc.exe" (
    echo Portable MinGW-w64 was not found: "%MINGW_BIN%\gcc.exe"
    echo Set MEDICT_MINGW_ROOT to the w64devkit directory.
    exit /b 1
)
if not exist "%MINGW_BIN%\ld.exe" exit /b 1
if not exist "%MINGW_BIN%\ar.exe" exit /b 1
if not exist "%MINGW_BIN%\windres.exe" exit /b 1

rustup toolchain list | findstr /b /c:"%TOOLCHAIN%" >nul
if errorlevel 1 (
    echo Rust GNU toolchain was not found: %TOOLCHAIN%
    exit /b 1
)
set "TARGET_FOUND="
for /f "delims=" %%T in ('rustup target list --installed --toolchain "%TOOLCHAIN%"') do if /i "%%T"=="%TARGET%" set "TARGET_FOUND=1"
if not defined TARGET_FOUND (
    echo Rust GNU target was not found: %TARGET%
    exit /b 1
)

set "PATH=%MINGW_BIN%;%PATH%"
set "RUSTUP_TOOLCHAIN=%TOOLCHAIN%"
set "CARGO_BUILD_TARGET=%TARGET%"
if defined MEDICT_CARGO_TARGET_DIR (
    set "CARGO_TARGET_DIR=%MEDICT_CARGO_TARGET_DIR%"
) else (
    set "CARGO_TARGET_DIR=%PROJECT_DIR%src-tauri\target"
)
set "CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER=%MINGW_BIN%\gcc.exe"
set "CC_x86_64_pc_windows_gnu=%MINGW_BIN%\gcc.exe"
set "AR_x86_64_pc_windows_gnu=%MINGW_BIN%\ar.exe"
set "RC_x86_64_pc_windows_gnu=%MINGW_BIN%\windres.exe"

set "HELPER=%REPO_DIR%\build\SelectionHelper.exe"
set "CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
set "WPF=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\WPF"
set "REBUILD_HELPER="
if /i "%~1"=="rebuild-helper" set "REBUILD_HELPER=1"
if /i "%~2"=="rebuild-helper" set "REBUILD_HELPER=1"
if not exist "%HELPER%" set "REBUILD_HELPER=1"

if defined REBUILD_HELPER (
    if not exist "%CSC%" (
        echo Windows C# compiler was not found: "%CSC%"
        exit /b 1
    )
    if not exist "%WPF%\UIAutomationClient.dll" (
        echo Windows UI Automation assemblies were not found: "%WPF%"
        exit /b 1
    )
    if not exist "%REPO_DIR%\build" mkdir "%REPO_DIR%\build"
    echo Building SelectionHelper.exe...
    "%CSC%" /nologo /target:winexe /platform:x64 /out:"%HELPER%" ^
        /reference:System.dll ^
        /reference:System.Core.dll ^
        /reference:System.Windows.Forms.dll ^
        /reference:"%WPF%\UIAutomationClient.dll" ^
        /reference:"%WPF%\UIAutomationTypes.dll" ^
        /reference:"%WPF%\WindowsBase.dll" ^
        "%REPO_DIR%\src\native\SelectionHelper.cs"
    if errorlevel 1 (
        echo SelectionHelper build failed.
        exit /b 1
    )
) else (
    echo Reusing existing SelectionHelper.exe.
)
if not exist "%HELPER%" (
    echo SelectionHelper.exe was not produced.
    exit /b 1
)

if not exist "%PROJECT_DIR%node_modules\.bin\tauri.cmd" (
    echo Tauri CLI was not found. Run npm install in tauri-app first.
    exit /b 1
)

pushd "%PROJECT_DIR%"
echo Using Rust target: %TARGET%
echo Using portable MinGW-w64: %MINGW_ROOT%
if /i "%~1"=="bundle" (
    call "%PROJECT_DIR%node_modules\.bin\tauri.cmd" build --target "%TARGET%"
) else (
    call "%PROJECT_DIR%node_modules\.bin\tauri.cmd" build --target "%TARGET%" --no-bundle
)
set "BUILD_STATUS=%ERRORLEVEL%"
popd

if not "%BUILD_STATUS%"=="0" (
    echo Tauri GNU build failed with exit code %BUILD_STATUS%.
    exit /b %BUILD_STATUS%
)

set "OUTPUT_EXE=%CARGO_TARGET_DIR%\%TARGET%\release\medict-tauri.exe"
if exist "%OUTPUT_EXE%" (
    echo Built: "%OUTPUT_EXE%"
) else (
    echo Build completed but the expected executable was not found:
    echo "%OUTPUT_EXE%"
    exit /b 1
)

endlocal
