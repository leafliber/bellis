/**
 * 凭据录入命令行（D-28）。维护者在自己的终端里运行，值从不回显的输入读取：
 *   pnpm secret list            只列出名字
 *   pnpm secret set <名字>      例如 obs：obs-websocket 的地址与密码
 *   pnpm secret delete <名字>
 */
import { KeyringSecretStore } from '@bellis/secret-store';
import { runSecretCommand, terminalPrompter } from './secret-command.ts';

const store = new KeyringSecretStore(process.env.BELLIS_SECRET_SERVICE ?? 'bellis');
const prompt = terminalPrompter(process.stdin, process.stdout);
let code: number;
try {
  code = await runSecretCommand(process.argv.slice(2), store, {
    prompt,
    print: (line) => console.log(line),
  });
} catch (error) {
  console.error((error as Error).message);
  code = 1;
} finally {
  prompt.close();
}
process.exit(code);
