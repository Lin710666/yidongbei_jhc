/**
 * preload —— 渲染进程与主进程之间唯一的桥。
 * 只暴露必要的方法，不开 nodeIntegration（见 main.js 的 webPreferences）。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hiki', {
  /** 启动本地后端，resolve 出 { ok, port } 或 { ok:false, error } */
  boot: () => ipcRenderer.invoke('app:boot'),
  /** 后端起好后把窗口切到应用页面 */
  goto: (port) => ipcRenderer.invoke('app:goto', port),
  /** 启动失败后重试 */
  retry: () => ipcRenderer.invoke('app:retry'),
  /** 打开后端日志（排错用） */
  openLog: () => ipcRenderer.invoke('app:openLog'),
  openDevTools: () => ipcRenderer.invoke('app:openDevTools'),
  /** 后端意外退出时主进程会推这个事件 */
  onBackendExited: (fn) => {
    ipcRenderer.on('backend-exited', (_e, info) => fn(info));
  },
});
