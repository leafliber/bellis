/**
 * 开发用 CLI 入口（非协议一部分）。
 *
 * 用法：node apps/runtime/dist/main.js --data-dir /abs/path [--port 17890]
 *                                      [--print-startup-token]
 *
 * - 数据目录必须显式传入绝对路径；默认端口 17890；只绑定 loopback。
 * - `--print-startup-token`：启动就绪后把一次性 Token 打印到 stdout 一行
 *   （不经 Pino Logger、不写任何持久日志），供本地测试客户端交换。
 * - SIGINT/SIGTERM 触发优雅关闭后退出。
 */
import { startRuntime } from "./index.js";

interface CliArgs {
  dataDirectory: string;
  port?: number;
  printToken: boolean;
}

function parseArgs(argv: readonly string[]): CliArgs | { error: string } {
  let dataDirectory: string | undefined;
  let port: number | undefined;
  let printToken = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      continue;
    }
    if (arg === "--print-startup-token") {
      printToken = true;
      continue;
    }
    if (arg === "--data-dir") {
      dataDirectory = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--port") {
      const value = argv[index + 1];
      index += 1;
      if (value === undefined || !/^\d+$/.test(value)) {
        return { error: "--port requires a numeric value" };
      }
      port = Number(value);
      continue;
    }
    return { error: `unknown argument: ${arg}` };
  }
  if (dataDirectory === undefined) {
    return { error: "--data-dir <absolute-path> is required" };
  }
  return { dataDirectory, ...(port === undefined ? {} : { port }), printToken };
}

const args = parseArgs(process.argv.slice(2));
if ("error" in args) {
  console.error(`runtime: ${args.error}`);
  process.exit(2);
}

const runtime = await startRuntime({
  config: {
    dataDirectory: args.dataDirectory,
    runtimeVersion: "0.1.0",
    ...(args.port === undefined ? {} : { port: args.port }),
  },
});

if (args.printToken) {
  const issued = runtime.issueStartupToken();
  // 单行 stdout 输出（非日志通道）；Token 不进入任何持久化日志。
  process.stdout.write(`startup-token ${issued.token}\n`);
}

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) {
    return;
  }
  closing = true;
  try {
    await runtime.close();
    process.exitCode = 0;
  } catch (error) {
    console.error(`runtime: close failed (${String(error)})`);
    process.exitCode = 1;
  }
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
