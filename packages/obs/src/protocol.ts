import { createHash } from 'node:crypto';

/** obs-websocket 5 协议中用到的部分。 */
export const OpCode = {
  Hello: 0,
  Identify: 1,
  Identified: 2,
  Event: 5,
  Request: 6,
  RequestResponse: 7,
  RequestBatch: 8,
  RequestBatchResponse: 9,
} as const;

export const RequestStatus = {
  Success: 100,
  MissingRequestType: 203,
  UnknownRequestType: 204,
  ResourceNotFound: 600,
  OutputRunning: 500,
  OutputNotRunning: 501,
} as const;

/**
 * Identify 时订阅的事件类别（obs-websocket 5 的 EventSubscription 位）。`CurrentProgramSceneChanged` 属于
 * Scenes，`InputMuteStateChanged` 属于 Inputs；InputVolumeMeters 是高频事件，单独一位。
 */
export const EventSubscription = {
  Scenes: 1 << 2,
  Inputs: 1 << 3,
  InputVolumeMeters: 1 << 16,
} as const;

/** 批量请求的执行方式：0 为按顺序实时执行。 */
export const SerialRealtime = 0;

export const AuthenticationFailed = 4009;

export const SUBPROTOCOL = 'obswebsocket.json';

/** 认证串：base64(sha256(base64(sha256(密码 + salt)) + challenge))。 */
export function authenticationString(password: string, salt: string, challenge: string): string {
  const secret = createHash('sha256')
    .update(password + salt)
    .digest('base64');
  return createHash('sha256')
    .update(secret + challenge)
    .digest('base64');
}

export interface ObsRequest {
  requestType: string;
  requestData?: Record<string, unknown>;
}

export interface ObsResult {
  requestType: string;
  ok: boolean;
  code: number;
  comment?: string;
  data?: Record<string, unknown>;
}

export interface Message {
  op: number;
  d: Record<string, unknown>;
}
