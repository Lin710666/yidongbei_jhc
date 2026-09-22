# 桌面版（Electron 外壳）

把本项目做成 **Windows 桌面应用**：双击图标即用，不要求用户装 Python、不要求开命令行。

## 一键打包

```
双击  desktop\打包桌面版.bat
```

产物：`desktop\dist\智能文旅辅助系统-<版本>-安装包.exe`（约 130 MB）

也可以分步做：

```bat
cd desktop
..\backend\.venv\Scripts\python.exe -X utf8 build-backend.py   :: 打后端 exe
npm install                                                     :: 装 Electron（首次约 270 MB）
node node_modules\electron-builder\cli.js --win nsis            :: 出安装包
```

只想本地跑起来看效果（不打包）：`npm start`

## 它由哪几块拼成

```
智能文旅辅助系统.exe           Electron 主程序（窗口 + 生命周期）
resources\app.asar             外壳源码：main.js / preload.js / renderer/
resources\backend\hiki-backend.exe   FastAPI 后端（PyInstaller 打成自包含）
resources\public\              整个前端（AirI 界面 + Live2D 模型与素材）
```

## 运行时是怎么协作的

```
Electron 主进程
   │  ① 先探一个空闲端口（不写死 8000，别人机器上很容易被占）
   │  ② 拉起 hiki-backend.exe，把端口和 public\ 的路径通过环境变量传进去
   │  ③ 轮询 /api/ping（毫秒级，不做外部调用）判断后端是否就绪
   │  ④ 就绪后把窗口从 loading.html 切到 http://127.0.0.1:<port>/
   └─ 退出时杀掉后端进程
```

窗口不是一上来就 `loadURL`，而是先显示 `renderer/loading.html`
（"正在启动本地服务…"）—— 后端冷启动要一两秒，直接载入会白屏。
后端起不来时，那个页面会变成错误页，带「重试 / 打开日志 / 开发者工具」，
并把后端 stderr 落到 `%APPDATA%\hikitravel-airi-desktop\backend.log`。

## 桌面版里的离线重连

按需求，桌面版同样带断网重连：后端中途崩了或被重启时，
页面顶部出现「连接已断开，正在重连…（第 N 次）」，指数退避持续探测
（1s→2s→4s，上限 8s），恢复后横幅变绿提示"已重新连接"并自动补拉数据。

探测打的是 `/api/ping` —— 这个路由**不做任何外部调用**，毫秒级返回。
不能用 `/api/status`：它会去探 Ollama，本机没启动 Ollama 时要等满超时，
拿它每几秒探一次既慢又浪费。

## 已知限制与注意

- **只打了 Windows x64**。要 macOS / Linux 安装包，改 `package.json` 里的
  `build.win` 为 `build.mac` / `build.linux`，并在对应系统上构建
  （electron-builder 不支持跨平台出包）。
- **安装包没做代码签名**。Windows SmartScreen 首次运行会提示"未知发布者"，
  点「更多信息 → 仍要运行」即可。想去掉提示需要买代码签名证书。
- **winCodeSign 解压需要符号链接权限**。electron-builder 首次会下载一个含
  macOS 符号链接的缓存包，普通权限下解压会报
  `Cannot create symbolic link ... 客户端没有所需的特权`。
  解决办法任选其一：打开 Windows「开发者模式」；或以管理员身份运行一次；
  或先手动解压（`7za x` 那份 7z，符号链接失败不影响 Windows 打包）。
- **Electron 与 NSIS 首次需要联网下载**。仓库里不放它们（`node_modules` 500+ MB）。
  国内网络已默认走 npmmirror 镜像，见 `打包桌面版.bat` 里的 `ELECTRON_MIRROR`。
- **后端 exe 不打进仓库**。27 MB 且可由 `build-backend.py` 重建，
  属于构建产物（`.gitignore` 已排除）。
