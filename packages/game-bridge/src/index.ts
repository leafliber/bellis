import { ClockService, definePlugin, type PluginContext } from '@bellis/kernel';
import { SafetyService } from '@bellis/safety';
import Type from 'typebox';
import { GameBridge, type GameBridgeConfig } from './bridge.ts';
import { GameRuntimePortService } from './host.ts';
import { GAME_GOAL, GAME_INPUT, GameFactObserved, GameService } from './service.ts';

export * from './host.ts';
export * from './service.ts';

const instances = new WeakMap<PluginContext<GameBridgeConfig>, GameBridge>();

export const gameBridge = definePlugin({
  manifest: {
    id: 'game-bridge',
    version: '0.1.0',
    tier: 'ordinary',
    process: 'in-process',
    provides: [GameService.ref],
    inject: [GameRuntimePortService.ref, ClockService.ref, SafetyService.ref],
    permissions: [GAME_GOAL, GAME_INPUT],
    config: Type.Object(
      {
        adapterId: Type.String({ pattern: '^[a-z][a-z0-9-]{0,47}$' }),
        adapterVersion: Type.String({ minLength: 1, maxLength: 32 }),
        healthTimeoutMs: Type.Optional(Type.Integer({ minimum: 50, maximum: 60_000 })),
      },
      { additionalProperties: false },
    ),
  },
  activate(ctx) {
    const bridge = new GameBridge(
      ctx,
      ctx.service(GameRuntimePortService),
      ctx.service(ClockService),
      ctx.service(SafetyService),
    );
    instances.set(ctx, bridge);
    ctx.register(() => {
      instances.delete(ctx);
    });
    bridge.start();
    ctx.register(bridge.subscribe((fact) => ctx.extensions.observe(GameFactObserved, fact)));
    ctx.provide(GameService, {
      status: () => bridge.status(),
      wireNowMs: () => bridge.wireNowMs(),
      subscribe: (listener) => bridge.subscribe(listener),
      submitGoal: (params, source, stillValid) => bridge.submitGoal(params, source, stillValid),
      resolveDecision: (params, source, stillValid) =>
        bridge.resolveDecision(params, source, stillValid),
    });
  },
  quiesce(ctx) {
    return instances.get(ctx)?.quiesce();
  },
});
