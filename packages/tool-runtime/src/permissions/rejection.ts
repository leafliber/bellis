/** A trusted adapter may use this only for a definite rejection before a remote write. */
export class ToolRejectedError extends Error {
  constructor(readonly code: string) {
    if (!/^[a-z][a-z0-9_.-]{0,63}$/.test(code)) throw new TypeError("invalid tool rejection code");
    super(code);
    this.name = "ToolRejectedError";
  }
}
