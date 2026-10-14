/**
 * 测试用子进程。用法：node child.ts <模式>
 *   cooperative      连接宿主，响应 process.shutdown 后退出；stdin EOF 时退出
 *   ignore-shutdown  连接宿主，应答 process.shutdown 但不退出；stdin EOF 时退出
 *   stubborn         不看 stdin，也不连宿主，一直运行
 *   lifeline-only    只看 stdin，EOF 时退出
 *   env              打印自己的环境变量名后退出
 */
import { connectToHost, handleShutdown, watchLifeline } from '../../src/index.ts';

const mode = process.argv[2];
const keepAlive = setInterval(() => {}, 1000);
const exit = () => {
  clearInterval(keepAlive);
  process.exit(0);
};

switch (mode) {
  case 'cooperative': {
    const rpc = await connectToHost('test.child');
    handleShutdown(rpc, exit);
    watchLifeline(exit);
    break;
  }
  case 'ignore-shutdown': {
    const rpc = await connectToHost('test.child');
    handleShutdown(rpc, () => {});
    watchLifeline(exit);
    break;
  }
  case 'stubborn':
    break;
  case 'lifeline-only':
    watchLifeline(exit);
    break;
  case 'env':
    console.log(JSON.stringify(Object.keys(process.env)));
    exit();
    break;
  default:
    throw new Error(`未知模式 ${mode}`);
}
console.log('ready');
