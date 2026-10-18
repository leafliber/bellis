import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { ClockService, definePlugin, type TimerHandle } from '@bellis/kernel';
import { SafetyService, STAGE_URL } from '@bellis/safety';
import Type from 'typebox';
import { type WebSocket, WebSocketServer } from 'ws';
import { type ObsAction, ObsControlService } from './obs-control.ts';
import { encodeAudio, isPageEvent, isPageFirst, isPageStats, type Welcome } from './page-wire.ts';
import { type FromPage, type PageLink, StagePageService, type ToPage } from './types.ts';

const PAGE_DIR = new URL('../page/', import.meta.url);
const FILES: Record<string, [file: string, type: string]> = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/page.js': ['page.js', 'text/javascript; charset=utf-8'],
  '/audio.js': ['audio.js', 'text/javascript; charset=utf-8'],
  '/subtitle.js': ['subtitle.js', 'text/javascript; charset=utf-8'],
  '/diagnostics.js': ['diagnostics.js', 'text/javascript; charset=utf-8'],
  '/worklet.js': ['worklet.js', 'text/javascript; charset=utf-8'],
  '/stage.css': ['stage.css', 'text/css; charset=utf-8'],
};
const SOCKET_PATH = '/stage';
/** 宿主拒绝认证；页面收到后不再重连，等宿主重新下发 URL。 */
const CLOSE_REJECTED = 4401;
const CLOSE_HELLO_TIMEOUT = 4408;

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * 真实 Stage 页面的宿主一侧（R-08）：在 127.0.0.1 的随机端口提供页面，在升级阶段认证 WebSocket，
 * 经 OBS 控制把一次性令牌写进 Stage 浏览器源 URL 的片段（安全停止下唯一允许的动作），
 * 页面出示令牌后换成只存于内存的会话密钥；同时只允许一个会话。
 *
 * - 每个请求与升级都要求 Host 严格相等；Origin 也须严格相等，唯一例外是页面文档 `/` 的顶层导航。
 * - 页面没有令牌（刷新后片段已被去掉）、令牌被拒，或会话断开后超过重连时限，按最小间隔重新下发 URL。
 * - 认证后的会话长时间没有任何消息即视为半开，断开。
 */
export const obsStagePage = definePlugin({
  manifest: {
    id: 'stage-page-obs',
    version: '0.1.0',
    tier: 'critical',
    provides: [StagePageService.ref],
    inject: [SafetyService.ref, ObsControlService.ref, ClockService.ref],
    permissions: [STAGE_URL],
    process: 'in-process',
    config: Type.Object({
      /** 升级后须在此时限内收到 hello 或 resume。 */
      helloTimeoutMs: Type.Integer({ minimum: 1, default: 2000 }),
      /** 认证后的会话超过这么久没有任何消息，视为半开连接并断开。 */
      idleTimeoutMs: Type.Integer({ minimum: 1, default: 3000 }),
      /** 会话断开后，会话密钥在这段时间内还能用来重连；过后重新下发 URL。 */
      resumeWindowMs: Type.Integer({ minimum: 0, default: 10_000 }),
      /** 两次下发 URL 的最小间隔。 */
      redistributeMinMs: Type.Integer({ minimum: 0, default: 5000 }),
      /** 页面发来的单条消息上限。 */
      maxMessageBytes: Type.Integer({ minimum: 256, default: 4096 }),
      /**
       * 诊断：页面 AudioContext 的 latencyHint。缺省 playback 即正常运行的取值；改成 interactive 只用于
       * 音画对齐的实验，经 URL 片段告诉页面。
       */
      latencyHint: Type.Union([Type.Literal('playback'), Type.Literal('interactive')], {
        default: 'playback',
      }),
      /** 诊断：页面每隔这么久回报一次浏览器自报的音频输出时延（stage-page.stats 日志）；0 为关闭。 */
      statsEveryMs: Type.Union([Type.Literal(0), Type.Integer({ minimum: 100, maximum: 60_000 })], {
        default: 0,
      }),
    }),
  },
  async activate(ctx) {
    const safety = ctx.service(SafetyService);
    const control = ctx.service(ObsControlService);
    const clock = ctx.service(ClockService);
    const config = ctx.config;
    const files = new Map(
      Object.entries(FILES).map(([path, [file, type]]) => [
        path,
        { body: readFileSync(new URL(file, PAGE_DIR)), type },
      ]),
    );
    const listeners = new Set<(message: FromPage) => void>();
    const emit = (message: FromPage) => {
      for (const listener of [...listeners]) listener(message);
    };

    let host = '';
    let origin = '';
    let token: string | undefined;
    let tokenUsed = false;
    let sessionKey: string | undefined;
    let resumeUntil = Number.NEGATIVE_INFINITY;
    /** 已认证的会话，与正在认证的连接（也占住会话位）。 */
    let session: WebSocket | undefined;
    let pending: WebSocket | undefined;
    let lastSeen = 0;
    let lastDistribution = Number.NEGATIVE_INFINITY;
    let distributing = false;
    let distributions = 0;
    let retry: TimerHandle | undefined;
    /** 已排的重新下发在何时触发（clock.now() 的刻度）。 */
    let retryAt = Number.POSITIVE_INFINITY;

    const refusal = (req: IncomingMessage, path: string, upgrade: boolean) => {
      if (req.headers.host !== host) return 'host';
      const sent = req.headers.origin;
      if (sent === undefined) {
        const navigation =
          !upgrade &&
          path === '/' &&
          req.headers['sec-fetch-mode'] === 'navigate' &&
          req.headers['sec-fetch-dest'] === 'document';
        return navigation ? undefined : 'origin-missing';
      }
      return sent === origin ? undefined : 'origin';
    };

    const onRequest = (req: IncomingMessage, res: ServerResponse) => {
      const path = (req.url ?? '').split('?')[0] ?? '';
      const reason = refusal(req, path, false);
      const file = files.get(path);
      if (reason || req.method !== 'GET' || !file) {
        if (reason) ctx.log('stage-page.refused', { kind: 'request', path, reason });
        res.writeHead(reason ? 403 : 404).end();
        return;
      }
      res.writeHead(200, {
        'content-type': file.type,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'content-security-policy': `default-src 'none'; script-src 'self'; style-src 'self'; connect-src ws://${host}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      });
      res.end(file.body);
    };

    const refuseUpgrade = (socket: Duplex, status: string) => {
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };

    const wss = new WebSocketServer({ noServer: true, maxPayload: config.maxMessageBytes });
    const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const path = (req.url ?? '').split('?')[0] ?? '';
      const reason = path !== SOCKET_PATH ? 'path' : refusal(req, path, true);
      if (reason) {
        ctx.log('stage-page.refused', { kind: 'upgrade', path, reason });
        refuseUpgrade(socket, '403 Forbidden');
        return;
      }
      if (session || pending || ctx.signal.aborted) {
        ctx.log('stage-page.refused', { kind: 'upgrade', path, reason: 'session-active' });
        refuseUpgrade(socket, '409 Conflict');
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => authenticate(ws));
    };

    /**
     * 排一次重新下发。已经排了更早的就不动；已排的更晚（例如会话断开后按重连时限排的）就提前到这一次，
     * 否则令牌被拒后要等到重连时限才重新下发，而不是按最小间隔。
     */
    const scheduleDistribute = (reason: string, delayMs: number) => {
      if (ctx.signal.aborted) return;
      const at = clock.now() + Math.max(0, delayMs);
      if (retry) {
        if (retryAt <= at) return;
        clock.clearTimeout(retry);
      }
      retryAt = at;
      retry = clock.setTimeout(
        () => {
          retry = undefined;
          void distribute(reason);
        },
        Math.max(0, delayMs),
      );
    };

    /** 生成新的一次性令牌，经 OBS 控制写进 Stage 浏览器源的 URL；失败或过频时稍后再试。 */
    const distribute = async (reason: string): Promise<void> => {
      if (distributing || session || ctx.signal.aborted) return;
      const wait = lastDistribution + config.redistributeMinMs - clock.now();
      if (wait > 0) {
        scheduleDistribute(reason, wait);
        return;
      }
      distributing = true;
      lastDistribution = clock.now();
      // 新令牌给重新加载的页面用；旧页面的会话密钥只按重连时限过期，不在这里作废。
      token = randomBytes(16).toString('base64url');
      tokenUsed = false;
      distributions += 1;
      // 诊断项只在与缺省不同时写进片段，正常运行的 URL 不变。
      const diagnostics =
        (config.latencyHint === 'playback' ? '' : `&l=${config.latencyHint}`) +
        (config.statsEveryMs > 0 ? `&s=${config.statsEveryMs}` : '');
      const action: ObsAction = { kind: 'stage-url', url: `${origin}/#t=${token}${diagnostics}` };
      try {
        const decision = await safety.authorize({
          key: `stage-url:${ctx.instanceId}:${distributions}`,
          type: 'stage.url',
          target: `obs:${safety.stageSource}`,
          payload: action,
          source: { origin: ctx.entryId, inputs: [], untrusted: false },
          capabilities: [STAGE_URL],
          timeSensitive: false,
        });
        if (!decision.allowed) throw new Error(decision.reason);
        const intent = await control.run(decision.intent, action);
        if (intent.state !== 'succeeded') throw new Error(intent.error ?? intent.state);
        ctx.log('stage-page.distributed', { reason });
      } catch (error) {
        ctx.log('stage-page.distribute-failed', { reason, error: (error as Error).message });
        scheduleDistribute(reason, config.redistributeMinMs);
      } finally {
        distributing = false;
      }
    };

    const reject = (ws: WebSocket, why: string) => {
      ctx.log('stage-page.rejected', { reason: why });
      ws.close(CLOSE_REJECTED, 'rejected');
    };

    const authenticate = (ws: WebSocket) => {
      pending = ws;
      const timer = clock.setTimeout(
        () => ws.close(CLOSE_HELLO_TIMEOUT, 'hello timeout'),
        config.helloTimeoutMs,
      );
      ws.on('close', () => {
        clock.clearTimeout(timer);
        if (pending === ws) pending = undefined;
        if (session !== ws) return;
        session = undefined;
        resumeUntil = clock.now() + config.resumeWindowMs;
        ctx.log('stage-page.disconnected');
        // 重连时限过后仍没有会话，重新下发 URL。
        scheduleDistribute('会话断开', config.resumeWindowMs);
      });
      ws.once('message', (data, isBinary) => {
        clock.clearTimeout(timer);
        let first: unknown;
        try {
          first = isBinary ? undefined : JSON.parse(String(data));
        } catch {
          first = undefined;
        }
        if (!isPageFirst.Check(first)) {
          reject(ws, 'first-message');
          return;
        }
        if (first.kind === 'hello') {
          if (first.token === null) {
            // 页面刷新后片段已被去掉，没有令牌：限频重新下发。
            reject(ws, 'no-token');
            void distribute('页面没有令牌');
            return;
          }
          if (token === undefined || tokenUsed || !same(first.token, token)) {
            reject(ws, 'token');
            void distribute('令牌被拒');
            return;
          }
          tokenUsed = true;
          sessionKey = randomBytes(32).toString('base64url');
          safety.record('stage.connected', {
            obs: first.obs,
            userAgent: first.userAgent,
            sampleRate: first.sampleRate,
          });
        } else if (
          sessionKey === undefined ||
          clock.now() > resumeUntil ||
          !same(first.sessionKey, sessionKey)
        ) {
          reject(ws, 'session-key');
          return;
        } else {
          ctx.log('stage-page.resumed');
        }
        open(ws, sessionKey);
      });
    };

    const open = (ws: WebSocket, key: string) => {
      pending = undefined;
      session = ws;
      lastSeen = clock.now();
      if (retry) {
        clock.clearTimeout(retry);
        retry = undefined;
      }
      const welcome: Welcome = { kind: 'welcome', sessionKey: key };
      ws.send(JSON.stringify(welcome));
      ctx.log('stage-page.authenticated');
      ws.on('message', (data, isBinary) => {
        lastSeen = clock.now();
        let message: unknown;
        try {
          message = isBinary ? undefined : JSON.parse(String(data));
        } catch {
          message = undefined;
        }
        // 诊断回报只在打开时接受，只记日志，不转给 Stage 服务。
        if (config.statsEveryMs > 0 && isPageStats.Check(message)) {
          const { kind: _kind, ...stats } = message;
          ctx.log('stage-page.stats', stats);
          return;
        }
        if (!isPageEvent.Check(message)) {
          ctx.log('stage-page.invalid-message');
          ws.terminate();
          return;
        }
        emit(message);
      });
    };

    // 回收半开连接。
    let idle: TimerHandle | undefined;
    const watchIdle = () => {
      idle = clock.setTimeout(watchIdle, Math.max(100, Math.floor(config.idleTimeoutMs / 3)));
      if (session && clock.now() - lastSeen > config.idleTimeoutMs) {
        ctx.log('stage-page.idle');
        session.terminate();
      }
    };

    const server = createServer(onRequest);
    server.on('upgrade', onUpgrade);
    await new Promise<void>((done, fail) => {
      server.once('error', fail);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', fail);
        done();
      });
    });
    const { port } = server.address() as AddressInfo;
    host = `127.0.0.1:${port}`;
    origin = `http://${host}`;
    ctx.log('stage-page.listening', { port });
    watchIdle();
    ctx.register(async () => {
      if (retry) clock.clearTimeout(retry);
      if (idle) clock.clearTimeout(idle);
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((done) => server.close(() => done()));
    });

    const link: PageLink = {
      get ready() {
        return session !== undefined;
      },
      send(message: ToPage) {
        if (!session) {
          // 不接受的句子也要回报，Stage 服务据此结束等待。
          if (message.kind === 'begin') {
            emit({
              kind: 'truncated',
              sentenceId: message.sentenceId,
              played: 0,
              reason: 'Stage 页面未连接',
            });
          }
          return;
        }
        if (message.kind === 'audio') {
          session.send(
            encodeAudio({ sentenceId: message.sentenceId, token: message.token }, message.pcm),
          );
        } else {
          session.send(JSON.stringify(message));
        }
      },
      onMessage(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    ctx.provide(StagePageService, link);
    // 激活完成、实例登记之后再下发：授权按实例核对权限。
    scheduleDistribute('启动', 0);
  },
});
