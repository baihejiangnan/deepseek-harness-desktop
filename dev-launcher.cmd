@echo off
rem DSH Launcher 开发模式启动入口（桌面快捷方式指向本文件）
cd /d "%~dp0"
pnpm tauri dev
