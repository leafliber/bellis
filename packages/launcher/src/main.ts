/**
 * 启动器入口（R-23）。Windows 上由“登录时运行”的计划任务启动（`pnpm autostart register` 注册，
 * 运行方式与停止见 docs/platform/windows.md 的“登录时运行”）；macOS 开发机直接运行。
 *   node packages/launcher/src/main.ts [配置文件]   缺省为 config/sim.json
 * 配置为 sim 时，启动器自己运行模拟 OBS 并把它的地址写入 SecretStore（与真实 OBS 的凭据分开存放），模拟 OBS 与真实 OBS 一样在宿主之外。
 * 宿主退出后不自动重启：看门狗接管现场，等待操作员处理。看门狗意外退出则由启动器重启。
 */
import { fileURLToPath } from 'node:url';
import { loadConfig, SIM_OBS_SECRET, writeObsSecret } from '@bellis/config';
import { SimObs } from '@bellis/obs';
import { logEvent } from '@bellis/process';
import { KeyringSecretStore } from '@bellis/secret-store';
import { launch } from './launch.ts';

const SECRET_SERVICE = 'bellis';
const script = (specifier: string) => fileURLToPath(import.meta.resolve(specifier));
const configPath =
  process.argv[2] ?? fileURLToPath(new URL('../../../config/sim.json', import.meta.url));
const config = loadConfig(configPath);
const secrets = new KeyringSecretStore(SECRET_SERVICE);

let simObs: SimObs | undefined;
if (config.simulation) {
  simObs = await SimObs.start({
    scenes: ['Live', config.safety.emergency.safeScene],
    inputs: [config.safety.emergency.stageSource],
  });
  await writeObsSecret(secrets, { url: simObs.url }, SIM_OBS_SECRET);
  logEvent('launcher.sim-obs', { url: simObs.url });
}

const session = await launch({
  configPath,
  secretService: SECRET_SERVICE,
  host: { command: process.execPath, args: [script('@bellis/host/main')] },
  watchdog: { command: process.execPath, args: [script('@bellis/watchdog/main')] },
  log: logEvent,
});
logEvent('launcher.ready', { sessionId: session.info.sessionId, pid: process.pid });

void session.host.exited.then((status) => logEvent('launcher.host-exited', { ...status }));

let stopping = false;
// 交互式控制台里的 Ctrl+C（Windows 控制台同样以 SIGINT 事件送达）。这是操作员的停止入口，不是进程间的停止协议。
process.on('SIGINT', () => {
  if (stopping) return;
  stopping = true;
  void session.stop().then(async (result) => {
    if (simObs) {
      await secrets.delete(SIM_OBS_SECRET);
      await simObs.close();
    }
    logEvent('launcher.stopped', { host: result.host.stage, watchdog: result.watchdog.stage });
    process.exit(0);
  });
});
