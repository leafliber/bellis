/**
 * 查看遥测（R-21）：
 *   pnpm telemetry summary [--config 配置文件] [--dir 目录]
 *   pnpm telemetry trace <trace 编号或至少 8 位前缀> [--config 配置文件] [--dir 目录]
 * 目录缺省按配置文件（缺省 config/sim.json）找：状态存储所在目录下、profile 里 `telemetry` 插件配置的 `dir`。
 * 只读文件，不连接宿主。
 */
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { telemetryDir } from './locate.ts';
import { formatSummary, formatTrace, loadDir, type TelemetryView } from './view.ts';

const USAGE = '用法：pnpm telemetry <summary | trace 编号> [--config 配置文件] [--dir 目录]';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { config: { type: 'string' }, dir: { type: 'string' } },
});
const [command, id] = positionals;
if (command !== 'summary' && !(command === 'trace' && id)) {
  console.error(USAGE);
  process.exit(2);
}
const dir =
  values.dir ??
  telemetryDir(
    values.config ?? fileURLToPath(new URL('../../../config/sim.json', import.meta.url)),
  );
let view: TelemetryView;
try {
  view = await loadDir(dir);
} catch (error) {
  console.error(`读不了遥测目录 ${dir}：${(error as NodeJS.ErrnoException).code ?? String(error)}`);
  process.exit(1);
}
console.log(`目录 ${dir}`);
console.log(command === 'summary' ? formatSummary(view) : formatTrace(view, id as string));
