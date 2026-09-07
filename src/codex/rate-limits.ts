import type { GetAccountRateLimitsResponse, RateLimitSnapshot } from "../codex-schema/v2";
import type { AccountRateLimitsRequest, JsonRpcResponse } from "./protocol";

export interface RateLimitManagerOptions {
  request: (
    request: Omit<AccountRateLimitsRequest, "id">,
    callback: (message: JsonRpcResponse<GetAccountRateLimitsResponse>) => void,
  ) => boolean;
  onStateChanged: () => void;
}

/** Owns the account-wide rate-limit snapshot and its read guard. */
export class CodexRateLimitManager {
  private rateLimits: RateLimitSnapshot | undefined;
  private readPending = false;

  constructor(private readonly options: RateLimitManagerOptions) {}

  getSnapshot(): RateLimitSnapshot | undefined {
    return structuredClone(this.rateLimits);
  }

  /** Reads the latest account-wide rate limits once until the response arrives. */
  refresh(): void {
    if (this.readPending) return;
    this.readPending = true;
    const accepted = this.options.request(
      { method: "account/rateLimits/read", params: undefined },
      (message) => {
        this.readPending = false;
        if (message.result?.rateLimits) {
          this.rateLimits = message.result.rateLimits;
          this.options.onStateChanged();
        }
      },
    );
    if (!accepted) this.readPending = false;
  }

  /** Applies a live account rate-limit notification. */
  handleUpdated(rateLimits: RateLimitSnapshot): void {
    this.rateLimits = rateLimits;
    this.options.onStateChanged();
  }

  /** Clears transport-scoped request state while retaining the last snapshot. */
  resetTransportState(): void {
    this.readPending = false;
  }
}
