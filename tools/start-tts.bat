@echo off
chcp 936 >nul
cd /d "%~dp0.."
title 文旅-QwenTTS语音服务

call "%~dp0env-detect.bat"

echo ==================================================
echo   Qwen TTS 本地语音合成服务
echo ==================================================
echo.

if not defined TTS_HOME (
  echo   [错误] 没找到本机的 Qwen TTS WebUI。
  echo.
  echo   请先安装 Qwen TTS WebUI，然后二选一告诉本脚本它在哪：
  echo     1）在项目根目录建一个 qwen-tts-home.txt，里面写一行安装路径，
  echo        例如：  E:\声音\qwen_tts_webui-licyk-20260407
  echo     2）或者设置环境变量 QWEN_TTS_HOME 指向该路径
  echo.
  echo   安装包地址：https://github.com/licyk/qwen-tts-webui
  echo.
  pause
  exit /b 1
)

echo   安装位置：%TTS_HOME%
echo   接口地址：http://127.0.0.1:7860
echo   合成模型：由项目自动挑选（8GB 显存会自动用 0.6B 那档）
echo.
echo   首次启动要把模型加载进显存，可能要等 30 秒到几分钟，请不要关闭本窗口。
echo   本窗口可以最小化；要停掉全部服务请运行项目根目录的 stop.bat。
echo.
echo --------------------------------------------------
echo.

cd /d "%TTS_CORE%"
"%TTS_PY%" launch.py --nowebui --server-name 127.0.0.1 --server-port 7860

echo.
echo --------------------------------------------------
echo   语音服务已退出。
pause
