/**
 * 重启演练用的“Iris 写入在途”注入：由 drill-p2-restart 以 `node --import <本文件的 URL>?hold-ms=<毫秒> 宿主入口`
 * 预加载进真实宿主进程。宿主写入 Iris 的请求（`POST …/api/v1/entries/<入口>/messages`）照常发出、Iris 照常收下，
 * 但应答先扣住 hold-ms 毫秒再交给宿主：这段时间里 Iris 已经存下这一批，宿主还没记 `memory.written`、写入意图
 * 停在执行中，演练在这时强制结束宿主。扣住时往标准输出写一行 JSON
 * `{"t":…,"event":"drill.iris-held","status":<HTTP 状态>,"holdMs":<毫秒>}`，不含请求与应答的内容。
 * hold-ms 要短于 Iris 客户端的 requestTimeoutMs（缺省 10 秒）：超过时客户端先按超时放弃，意图就不在执行中了。
 * 只改本进程里的 `globalThis.fetch`，不改配置、凭据与 Iris；召回等其它请求原样放行。只用于演练，不进入正式代码路径。
 */
const holdMs = Number(new URL(import.meta.url).searchParams.get('hold-ms'));
if (!(Number.isInteger(holdMs) && holdMs > 0))
  throw new Error('drill-iris-hold：缺少 hold-ms 参数');

const WRITE = /\/api\/v1\/entries\/[^/]+\/messages$/;
const original = globalThis.fetch.bind(globalThis);

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  const response = await original(input, init);
  if (method === 'POST' && WRITE.test(new URL(url).pathname)) {
    console.log(
      JSON.stringify({
        t: new Date().toISOString(),
        event: 'drill.iris-held',
        status: response.status,
        holdMs,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, holdMs));
  }
  return response;
}) as typeof fetch;
