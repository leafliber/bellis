export type ChannelErrorCode =
  /** 监听地址已被占用：会话地址每次随机生成，出现即视为可能被抢注，不得用同名重试。 */
  | 'address-in-use'
  /** 地址超出平台限制（UDS 路径长度）。 */
  | 'address-invalid'
  /** 会话密钥长度不对。 */
  | 'invalid-key'
  /** 同时进行的未认证握手已达上限。 */
  | 'busy'
  /** 连接不到对端。 */
  | 'connect-failed'
  /** 对端未能证明持有会话密钥。 */
  | 'auth-failed'
  | 'handshake-timeout'
  | 'frame-too-large'
  /** 帧或消息不符合协议。 */
  | 'protocol-error'
  | 'timeout'
  | 'closed';

export class ChannelError extends Error {
  readonly code: ChannelErrorCode;

  constructor(code: ChannelErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ChannelError';
    this.code = code;
  }
}
