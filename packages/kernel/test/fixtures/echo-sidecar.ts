/**
 * 测试用 sidecar：提供 echo@1。
 *   node echo-sidecar.ts [extra-service]  额外声明一个服务，用来测试清单不一致
 */
import { serveSidecar } from '../../src/index.ts';

const extra = process.argv[2];
await serveSidecar({
  provides: extra ? ['echo@1', extra] : ['echo@1'],
  setup(rpc) {
    rpc.handle('echo.say', ({ text }) => ({ text, pid: process.pid }));
  },
});
