/**
 * 结构化日志：每行一个 JSON 对象，写到标准输出，由启动器或运维工具收集。
 * 日志不是事实来源；持久事实写在状态存储里。
 */
export function logEvent(event: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), event, ...fields })}\n`);
}
