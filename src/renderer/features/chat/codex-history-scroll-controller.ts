type ScrollMode = "following-latest" | "reading";

interface ScrollDebugDetails {
  [key: string]: unknown;
}

export class CodexHistoryScrollController {
  private static nextInstanceId = 1;
  private readonly instanceId = CodexHistoryScrollController.nextInstanceId++;
  private readonly debugEnabled = this.isDebugEnabled();
  private mode: ScrollMode = "following-latest";
  private userScrollPending = false;
  private frame: number | undefined;
  private transaction = 0;
  private token: object | undefined;
  private pendingReaderPosition: number | undefined;
  private extentLocked = false;
  private lockedTargetScrollTop = 0;

  constructor(
    private readonly viewport: HTMLElement,
    private readonly content: HTMLElement,
  ) {}

  reset(): void {
    this.cancelWork();
    this.releaseExtentLock();
    this.mode = "following-latest";
    this.userScrollPending = false;
  }

  noteManualScroll(): void {
    this.log("manual-scroll-start");
    this.cancelWork();
    this.releaseExtentLock();
    this.viewport.scrollTo({ top: this.viewport.scrollTop, behavior: "auto" });
    this.userScrollPending = true;
    this.mode = "reading";
  }

  handleScroll(): void {
    if (!this.userScrollPending) return;
    this.log("manual-scroll-event");
    this.userScrollPending = false;
    if (this.viewport.clientHeight <= 0) return;
    this.mode = this.isNearBottom() ? "following-latest" : "reading";
  }

  handleResize(): void {
    this.tryReleaseExtentLock();
    if (this.isFollowing()) {
      this.cancelWork();
      this.settleBottomNow();
    } else if (this.pendingReaderPosition !== undefined) {
      this.restoreReaderPosition(this.pendingReaderPosition);
    }
  }

  isFollowing(): boolean {
    return this.mode === "following-latest";
  }

  shouldFollowUpdate(): boolean {
    if (this.viewport.clientHeight <= 0) return this.isFollowing();
    if (!this.isNearBottom()) return false;
    this.mode = "following-latest";
    this.userScrollPending = false;
    return true;
  }

  isNearBottom(): boolean {
    if (this.viewport.clientHeight <= 0) return this.isFollowing();
    return this.getMaxScrollTop() - this.viewport.scrollTop <= this.viewport.clientHeight * 0.05;
  }

  scrollToLatest(force = true): void {
    this.log("scroll-to-latest-request", { force });
    if (force) {
      this.mode = "following-latest";
      this.userScrollPending = false;
    }
    if (!this.isFollowing()) return;
    if (!force) {
      this.cancelWork();
      this.settleBottomNow();
      return;
    }
    this.scheduleProgrammatic(() => {
      if (!this.isFollowing()) return;
      const top = this.getMaxScrollTop();
      this.viewport.scrollTo({ top, behavior: "smooth" });
      this.viewport.scrollTop = top;
    });
  }

  scrollToTop(): void {
    this.noteManualScroll();
    this.scheduleProgrammatic(() => {
      this.viewport.scrollTo({ top: 0, behavior: "smooth" });
    });
  }

  scrollBy(top: number): void {
    this.noteManualScroll();
    this.scheduleProgrammatic(() => {
      this.viewport.scrollBy({ top, behavior: "smooth" });
    });
  }

  revealMessage(message: HTMLElement): void {
    this.noteManualScroll();
    this.scheduleProgrammatic(() => {
      message.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
  }

  lockContentExtent(previousScrollHeight: number): void {
    if (this.viewport.clientHeight > 0 && previousScrollHeight > 0) {
      this.content.style.minHeight = `${previousScrollHeight}px`;
      this.lockedTargetScrollTop = this.viewport.scrollTop;
      this.extentLocked = true;
      this.log("reader-extent-locked", {
        previousScrollHeight,
        targetScrollTop: this.lockedTargetScrollTop,
      });
    }
  }

  restoreReaderPosition(scrollTop: number): void {
    this.cancelWork();
    this.pendingReaderPosition = scrollTop;
    const transaction = this.transaction;
    const token = {};
    this.token = token;
    this.frame = requestAnimationFrame(() => {
      if (this.token !== token || this.transaction !== transaction) {
        this.log("stale-reader-restore-ignored", {
          transaction,
          currentTransaction: this.transaction,
        });
        return;
      }
      this.frame = undefined;
      if (this.isFollowing()) return;
      if (this.getMaxScrollTop() < scrollTop) {
        this.log("reader-restore-deferred", {
          target: scrollTop,
          availableMaxScrollTop: this.getMaxScrollTop(),
        });
        return;
      }
      this.pendingReaderPosition = undefined;
      this.viewport.scrollTop = scrollTop;
      this.tryReleaseExtentLock();
      this.log("reader-restore-applied", { target: scrollTop });
    });
  }

  private settleBottomNow(): void {
    this.releaseExtentLock();
    if (this.viewport.clientHeight <= 0 || !this.isFollowing()) return;
    this.viewport.scrollTop = this.getMaxScrollTop();
  }

  private scheduleProgrammatic(action: () => void): void {
    this.cancelWork();
    this.releaseExtentLock();
    const transaction = this.transaction;
    const token = {};
    this.token = token;
    this.frame = requestAnimationFrame(() => {
      if (this.token !== token || this.transaction !== transaction) {
        this.log("stale-programmatic-scroll-ignored", {
          transaction,
          currentTransaction: this.transaction,
        });
        return;
      }
      this.frame = undefined;
      action();
    });
  }

  private cancelWork(): void {
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    this.frame = undefined;
    this.token = undefined;
    this.pendingReaderPosition = undefined;
    this.transaction += 1;
  }

  private releaseExtentLock(): void {
    if (!this.extentLocked) return;
    this.content.style.minHeight = "";
    this.lockedTargetScrollTop = 0;
    this.extentLocked = false;
  }

  private tryReleaseExtentLock(): boolean {
    if (!this.extentLocked) return true;

    const lockedMinHeight = this.content.style.minHeight;
    const previousScrollTop = this.viewport.scrollTop;
    this.content.style.minHeight = "";
    const canRelease = this.getMaxScrollTop() >= this.lockedTargetScrollTop;
    if (canRelease) {
      this.lockedTargetScrollTop = 0;
      this.extentLocked = false;
      this.log("reader-extent-unlocked");
      return true;
    }

    this.content.style.minHeight = lockedMinHeight;
    this.viewport.scrollTop = Math.max(previousScrollTop, this.lockedTargetScrollTop);
    this.log("reader-extent-remains-locked", {
      targetScrollTop: this.lockedTargetScrollTop,
      naturalMaxScrollTop: this.getMaxScrollTop(),
    });
    return false;
  }

  private getMaxScrollTop(): number {
    return Math.max(0, this.viewport.scrollHeight - this.viewport.clientHeight);
  }

  private log(event: string, details: ScrollDebugDetails = {}): void {
    if (!this.debugEnabled) return;
    console.log("[Pesk chat scroll]", event, {
      instanceId: this.instanceId,
      transaction: this.transaction,
      mode: this.mode,
      scrollTop: this.viewport.scrollTop,
      scrollHeight: this.viewport.scrollHeight,
      clientHeight: this.viewport.clientHeight,
      maxScrollTop: this.getMaxScrollTop(),
      userScrollPending: this.userScrollPending,
      visibilityState: document.visibilityState,
      ...details,
    });
  }

  private isDebugEnabled(): boolean {
    try {
      return window.localStorage.getItem("pesk.chatScrollDebug") === "1";
    } catch {
      return false;
    }
  }
}
