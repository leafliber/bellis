import Type, { type Static } from 'typebox';

/**
 * 控制面 JSON-RPC 2.0 消息（D-21）。
 * 参数只用按名传递的对象，不用按位置传递的数组。
 */

const closed = { additionalProperties: false } as const;

export const RpcVersion = Type.Literal('2.0');

/** 数字 id 限定在安全整数范围内，避免解析后不同 id 相撞。 */
export const RpcId = Type.Union([
  Type.String({ minLength: 1, maxLength: 128 }),
  Type.Integer({ minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER }),
]);
export type RpcId = Static<typeof RpcId>;

/** 方法名形如 `对象.动作`，例如 `speech.request`；至少有一段动作。 */
export const RpcMethod = Type.String({ pattern: '^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)+$' });

export const RpcParams = Type.Record(Type.String(), Type.Unknown());
export type RpcParams = Static<typeof RpcParams>;

export const RpcRequest = Type.Object(
  { jsonrpc: RpcVersion, id: RpcId, method: RpcMethod, params: Type.Optional(RpcParams) },
  closed,
);
export type RpcRequest = Static<typeof RpcRequest>;

export const RpcNotification = Type.Object(
  { jsonrpc: RpcVersion, method: RpcMethod, params: Type.Optional(RpcParams) },
  closed,
);
export type RpcNotification = Static<typeof RpcNotification>;

export const RpcErrorObject = Type.Object(
  { code: Type.Integer(), message: Type.String(), data: Type.Optional(Type.Unknown()) },
  closed,
);
export type RpcErrorObject = Static<typeof RpcErrorObject>;

export const RpcSuccess = Type.Object(
  { jsonrpc: RpcVersion, id: RpcId, result: Type.Unknown() },
  closed,
);
export type RpcSuccess = Static<typeof RpcSuccess>;

/** 无法解析请求时 id 为 null（JSON-RPC 2.0 第 5 节）。 */
export const RpcFailure = Type.Object(
  { jsonrpc: RpcVersion, id: Type.Union([RpcId, Type.Null()]), error: RpcErrorObject },
  closed,
);
export type RpcFailure = Static<typeof RpcFailure>;

export const RpcMessage = Type.Union([RpcRequest, RpcNotification, RpcSuccess, RpcFailure]);
export type RpcMessage = Static<typeof RpcMessage>;

/** JSON-RPC 2.0 预定义错误码。 */
export const RpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;
