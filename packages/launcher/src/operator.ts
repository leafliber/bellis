/**
 * 操作员命令行。从 SecretStore 读取本次会话的连接信息，以 operator 角色连接宿主；
 * 与操作台调用宿主里同一套操作员动作（R-20）。
 *   pnpm operator status
 *   pnpm operator mode <M0|M1|M2|M3|safe-stop>
 *   pnpm operator presence
 *   pnpm operator estop [原因]
 *   pnpm operator veto [句键]            M1 中否决等待放行的句子；不给句键时否决全部（句键见 status 的 held）
 *   pnpm operator release [句键]         M1 中放行等待的句子；不给句键时放行全部
 *   pnpm operator preflight [M1|M2|M3]   只跑开播预检，不切换模式
 *   pnpm operator console                用浏览器打开本机操作台（一次性登录令牌）
 */
import { connect, decodeSessionKey, RpcPeer } from '@bellis/channel';
import { Role } from '@bellis/protocol';
import { KeyringSecretStore, readSessionInfo } from '@bellis/secret-store';
import {
  OPERATOR_USAGE,
  openBrowser,
  parseOperatorArgs,
  requestTimeoutMs,
  runOperatorCommand,
} from './operator-command.ts';

const args = process.argv.slice(2);
if (!parseOperatorArgs(args)) {
  console.error(OPERATOR_USAGE);
  process.exit(2);
}

const info = await readSessionInfo(
  new KeyringSecretStore(process.env.BELLIS_SECRET_SERVICE ?? 'bellis'),
);
if (!info) {
  console.error('没有正在运行的会话');
  process.exit(1);
}
const connection = await connect(info.channelPath, Role.Operator, {
  key: decodeSessionKey(info.channelKey),
});
const rpc = new RpcPeer(connection, { timeoutMs: 5000 });
try {
  process.exitCode = await runOperatorCommand(args, {
    request: (method, params) =>
      rpc.request(method, params, { timeoutMs: requestTimeoutMs(method) }),
    open: (url) => openBrowser(url),
    print: (line) => console.log(line),
  });
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  connection.close();
}
