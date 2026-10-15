/** 测试用父进程：启动一个只看生命线的子进程，打印其 pid 后一直运行，等待被强制终止。 */
import { fileURLToPath } from 'node:url';
import { baseEnvironment, ManagedProcess } from '../../src/index.ts';

const child = await ManagedProcess.start({
  name: 'grandchild',
  command: process.execPath,
  args: [fileURLToPath(new URL('./child.ts', import.meta.url)), 'lifeline-only'],
  env: baseEnvironment(),
  stdout: 'ignore',
});
console.log(JSON.stringify({ childPid: child.pid }));
setInterval(() => {}, 1000);
