/**
 * 在指定写入点把自己强制终止，用来验证真实崩溃后的恢复。
 *   node crash-run.ts <数据库> <副作用记录文件> <写入点>
 */
import { appendFileSync } from 'node:fs';
import { executeOnce, StateStore } from '../../src/index.ts';
import { intent } from '../helpers.ts';

const [path, effects, crashPoint] = process.argv.slice(2) as [string, string, string];
const store = StateStore.open({
  path,
  fault: (point) => {
    if (point === crashPoint) process.kill(process.pid, 'SIGKILL');
  },
});
await executeOnce(store, intent('k'), async () => {
  appendFileSync(effects, 'x');
  return null;
});
console.log('没有在预期的写入点终止');
