import {
  RpcErrorObject,
  RpcFailure,
  RpcMessage,
  RpcNotification,
  RpcRequest,
  RpcSuccess,
} from './jsonrpc.ts';

export * from './jsonrpc.ts';

/**
 * 需要生成 JSON Schema 文件的类型，按模块分组。
 * 每个模块生成 `schemas/<模块>.schema.json`，类型放在 `$defs` 下。
 */
export const schemaModules = {
  jsonrpc: { RpcRequest, RpcNotification, RpcSuccess, RpcFailure, RpcErrorObject, RpcMessage },
} as const;
