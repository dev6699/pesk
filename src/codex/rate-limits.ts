import type {
  GetAccountRateLimitsResponse,
  RateLimitSnapshot,
  RateLimitWindow,
} from "../codex-schema/v2";
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
    this.rateLimits = mergeRateLimitSnapshot(this.rateLimits, rateLimits);
    this.options.onStateChanged();
  }

  /** Clears transport-scoped request state while retaining the last snapshot. */
  resetTransportState(): void {
    this.readPending = false;
  }
}

function mergeRateLimitSnapshot(
  previous: RateLimitSnapshot | undefined,
  update: RateLimitSnapshot,
): RateLimitSnapshot {
  if (!previous) return structuredClone(update);

  const sparseUpdate = update as Partial<RateLimitSnapshot>;
  return {
    ...previous,
    ...sparseUpdate,
    limitId: sparseUpdate.limitId ?? previous.limitId,
    limitName: sparseUpdate.limitName ?? previous.limitName,
    normalModelSlug: sparseUpdate.normalModelSlug ?? previous.normalModelSlug,
    primary: mergeRateLimitWindow(previous.primary, sparseUpdate.primary),
    secondary: mergeRateLimitWindow(previous.secondary, sparseUpdate.secondary),
    credits: sparseUpdate.credits ?? previous.credits,
    individualLimit: sparseUpdate.individualLimit ?? previous.individualLimit,
    spendControlReached: sparseUpdate.spendControlReached ?? previous.spendControlReached,
    planType: sparseUpdate.planType ?? previous.planType,
    rateLimitReachedType: sparseUpdate.rateLimitReachedType ?? previous.rateLimitReachedType,
  };
}

function mergeRateLimitWindow(
  previous: RateLimitWindow | null,
  update: RateLimitWindow | null | undefined,
): RateLimitWindow | null {
  if (!update) return previous;
  return {
    ...previous,
    ...update,
  };
}
