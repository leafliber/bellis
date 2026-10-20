import { ChannelAccept, ChannelChallenge, ChannelHello, ChannelProof } from './channel.ts';
import { HostConfig, ObsSecret } from './config.ts';
import {
  RpcCancelParams,
  RpcErrorObject,
  RpcFailure,
  RpcMessage,
  RpcNotification,
  RpcRequest,
  RpcSuccess,
} from './jsonrpc.ts';
import {
  PluginManifest,
  Profile,
  ProfilePatch,
  SidecarDescription,
  SidecarHealthResult,
} from './plugin.ts';
import {
  HostHeartbeatParams,
  HostStatusResult,
  HostStoppingParams,
  OperatorConsoleLoginResult,
  OperatorEmergencyParams,
  OperatorModeParams,
  OperatorPreflightParams,
  OperatorReleaseParams,
  OperatorVetoParams,
  ProcessShutdownParams,
  ProcessShutdownResult,
  SessionInfo,
  WatchdogActedParams,
} from './process.ts';
import {
  TtsInfoResult,
  TtsStatus,
  TtsSynthesizeParams,
  TtsSynthesizeResult,
  TtsWordsParams,
} from './tts.ts';

export * from './channel.ts';
export * from './config.ts';
export * from './jsonrpc.ts';
export * from './plugin.ts';
export * from './process.ts';
export * from './tts.ts';

/**
 * 需要生成 JSON Schema 文件的类型，按模块分组。
 * 每个模块生成 `schemas/<模块>.schema.json`，类型放在 `$defs` 下。
 */
export const schemaModules = {
  config: { HostConfig, ObsSecret },
  channel: { ChannelHello, ChannelChallenge, ChannelProof, ChannelAccept },
  jsonrpc: {
    RpcRequest,
    RpcNotification,
    RpcSuccess,
    RpcFailure,
    RpcErrorObject,
    RpcMessage,
    RpcCancelParams,
  },
  plugin: { PluginManifest, Profile, ProfilePatch, SidecarDescription, SidecarHealthResult },
  process: {
    SessionInfo,
    ProcessShutdownParams,
    ProcessShutdownResult,
    HostStoppingParams,
    HostStatusResult,
    HostHeartbeatParams,
    OperatorModeParams,
    OperatorEmergencyParams,
    OperatorVetoParams,
    OperatorReleaseParams,
    OperatorPreflightParams,
    OperatorConsoleLoginResult,
    WatchdogActedParams,
  },
  tts: { TtsInfoResult, TtsStatus, TtsSynthesizeParams, TtsSynthesizeResult, TtsWordsParams },
} as const;
