/**
 * 操作员命令行（P0；操作台待 R-20）。从 SecretStore 读取本次会话的连接信息，以 operator 角色连接宿主。
 *   pnpm operator status
 *   pnpm operator mode <M0|M1|M2|M3|safe-stop>
 *   pnpm operator presence
 *   pnpm operator estop [原因]
 *   pnpm operator veto [句键]          M1 中否决等待放行的句子；不给句键时否决全部（句键见 status 的 held）
 *   pnpm operator preflight [M1|M2]    只跑开播预检，不切换模式
 */
import { connect, decodeSessionKey, RpcPeer } from '@bellis/channel';
import { OperatorMethod, Role } from '@bellis/protocol';
import { KeyringSecretStore, readSessionInfo } from '@bellis/secret-store';

const [command, argument] = process.argv.slice(2);
const calls: Record<string, () => [string, Record<string, unknown>]> = {
  status: () => [OperatorMethod.Status, {}],
  mode: () => [OperatorMethod.Mode, { target: argument ?? '' }],
  presence: () => [OperatorMethod.Presence, {}],
  estop: () => [OperatorMethod.EmergencyStop, { reason: argument ?? '操作员急停' }],
  veto: () => [OperatorMethod.Veto, argument ? { key: argument } : {}],
  preflight: () => [OperatorMethod.Preflight, argument ? { target: argument } : {}],
};
const call = command ? calls[command] : undefined;
if (!call) {
  console.error(
    '用法：operator <status | mode 目标 | presence | estop [原因] | veto [句键] | preflight [M1|M2]>',
  );
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
const [method, params] = call();
console.log(JSON.stringify(await rpc.request(method, params), null, 2));
connection.close();
