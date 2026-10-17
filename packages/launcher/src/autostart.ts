/**
 * “登录时运行”的计划任务（R-23、R-26）。维护者在自己的终端里运行，只在 Windows 上可用：
 *   pnpm autostart register [配置文件]   缺省为 config/live.json；覆盖已有的同名任务，注册后读回核对
 *   pnpm autostart unregister
 *   pnpm autostart status                读回任务并核对
 * 任务运行的是执行本命令的 node，换了 Node 的安装位置或移动了仓库要重新注册。
 */
import { userInfo } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAutostartCommand, spawnSchtasks } from './autostart-command.ts';
import { currentUserId } from './task-xml.ts';

const fromHere = (relative: string) => resolve(fileURLToPath(new URL(relative, import.meta.url)));

const code = await runAutostartCommand(process.argv.slice(2), {
  platform: process.platform,
  schtasks: spawnSchtasks(),
  print: (line) => console.log(line),
  currentUser: () => currentUserId(userInfo().username, process.env.USERDOMAIN),
  launcher: {
    node: process.execPath,
    entry: fromHere('./main.ts'),
    root: fromHere('../../../'),
  },
  cwd: process.cwd(),
  defaultConfig: fromHere('../../../config/live.json'),
});
process.exit(code);
