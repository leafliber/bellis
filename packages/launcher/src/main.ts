/**
 * 启动器入口（R-23）。Windows 上由“登录时运行”的计划任务启动（P1 注册）；macOS 开发机直接运行。
 * 宿主退出后不自动重启：看门狗接管现场，等待操作员处理。看门狗意外退出则由启动器重启。
 */
import { fileURLToPath } from 'node:url';
import { logEvent } from '@bellis/process';
import { launch } from './launch.ts';

const SECRET_SERVICE = 'bellis';
const script = (specifier: string) => fileURLToPath(import.meta.resolve(specifier));

const session = await launch({
  secretService: SECRET_SERVICE,
  log: logEvent,
  host: { command: process.execPath, args: [script('@bellis/host/main')] },
  watchdog: { command: process.execPath, args: [script('@bellis/watchdog/main')] },
});
logEvent('launcher.ready', { sessionId: session.info.sessionId, pid: process.pid });

void session.host.exited.then((status) => logEvent('launcher.host-exited', { ...status }));

let stopping = false;
// 交互式控制台里的 Ctrl+C（Windows 控制台同样以 SIGINT 事件送达）。这是操作员的停止入口，不是进程间的停止协议。
process.on('SIGINT', () => {
  if (stopping) return;
  stopping = true;
  void session.stop().then((result) => {
    logEvent('launcher.stopped', { host: result.host.stage, watchdog: result.watchdog.stage });
    process.exit(0);
  });
});
