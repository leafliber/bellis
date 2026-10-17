/**
 * 凭据录入命令行（D-28）。维护者在自己的终端里运行，值从不回显的输入读取：
 *   pnpm secret list            只列出名字
 *   pnpm secret set <名字>      例如 obs：obs-websocket 的地址与密码
 *   pnpm secret delete <名字>
 *   pnpm secret audit [路径…]   核对文件中有没有凭据的值；只输出文件、条目名、编码与次数
 */
import { fileURLToPath } from 'node:url';
import { KeyringSecretStore } from '@bellis/secret-store';
import { runSecretCommand, terminalPrompter } from './secret-command.ts';

const store = new KeyringSecretStore(process.env.BELLIS_SECRET_SERVICE ?? 'bellis');
const prompt = terminalPrompter(process.stdin, process.stdout);
let code: number;
try {
  code = await runSecretCommand(process.argv.slice(2), store, {
    prompt,
    print: (line) => console.log(line),
    cwd: process.cwd(),
    root: fileURLToPath(new URL('../../../', import.meta.url)),
  });
} catch (error) {
  console.error((error as Error).message);
  code = 1;
} finally {
  prompt.close();
}
process.exit(code);
