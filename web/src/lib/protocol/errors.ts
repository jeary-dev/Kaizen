/** Failure reasons from protocol §10, shared with the plugin. */
export type Reason = "malformed" | "unsupported" | "auth" | "oversize" | "mismatch" | "path" | "placeholder";

export class ProtocolError extends Error {
  readonly reason: Reason;

  constructor(reason: Reason, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ProtocolError";
    this.reason = reason;
  }
}

export const fail = (reason: Reason, message: string, cause?: unknown): never => {
  throw new ProtocolError(reason, message, cause === undefined ? undefined : { cause });
};
