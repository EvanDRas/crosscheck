@echo off
rem Minimal server runner for the app launcher (run hidden by the .vbs).
cd /d "%~dp0.."
node server.js
