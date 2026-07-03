// electron-vite 的 ?modulePath：导入子进程入口的构建后路径（供 fork 使用——ASR 走
// utilityProcess.fork，翻译走 child_process.fork）。产物是独立 CJS chunk，可直接被 fork。
declare module '*?modulePath' {
  const path: string;
  export default path;
}
