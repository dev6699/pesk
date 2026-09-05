import type { Model } from "../codex-schema/v2";
import type { CodexModelPicker } from "./types";
import type {
  JsonRpcResponse,
  ModelListRequest,
  ModelListResponse,
  ThreadSettingsUpdateRequest,
  ThreadSettingsUpdateResponse,
} from "./protocol";

export type ModelRequestInput =
  Omit<ModelListRequest, "id"> | Omit<ThreadSettingsUpdateRequest, "id">;

export interface ModelManagerOptions {
  request: <TResult>(
    request: ModelRequestInput,
    callback: (message: JsonRpcResponse<TResult>) => void,
  ) => void;
  getSelectedThreadId: () => string | undefined;
  publishRendererState: () => void;
  setCommandNotice: (notice: string) => void;
}

/** Owns the interactive model picker and future-turn model settings. */
export class CodexModelManager {
  private picker: CodexModelPicker | undefined;
  private requestGeneration = 0;

  constructor(private readonly options: ModelManagerOptions) {}

  /** Returns the current renderer-facing picker state. */
  getPicker(): CodexModelPicker | undefined {
    return this.picker;
  }

  /** Loads all available models for the currently selected thread. */
  begin(): boolean {
    const threadId = this.options.getSelectedThreadId();
    if (!threadId) {
      this.options.setCommandNotice("No active thread to change model.");
      this.options.publishRendererState();
      return false;
    }

    const generation = ++this.requestGeneration;
    const models: Model[] = [];
    this.loadModels(threadId, generation, null, models);
    return true;
  }

  /** Advances the picker or updates the selected thread's future-turn settings. */
  select(model: string, effort: string): void {
    const picker = this.picker;
    const threadId = this.options.getSelectedThreadId();
    if (!picker || !threadId) return;
    const selectedModel = picker.models.find((candidate) => candidate.model === model);
    if (!selectedModel) return;
    if (!effort) {
      this.picker = { stage: "effort", models: picker.models, selectedModel };
      this.options.publishRendererState();
      return;
    }
    if (!selectedModel.supportedReasoningEfforts.some((item) => item.reasoningEffort === effort))
      return;

    const generation = this.requestGeneration;
    this.options.request<ThreadSettingsUpdateResponse>(
      {
        method: "thread/settings/update",
        params: { threadId, model, effort },
      },
      (message) => {
        if (
          generation !== this.requestGeneration ||
          threadId !== this.options.getSelectedThreadId()
        )
          return;
        this.picker = undefined;
        if (message?.error) this.options.setCommandNotice("Unable to change the model.");
        this.options.publishRendererState();
      },
    );
  }

  /** Cancels the picker and invalidates all pending model operations. */
  cancel(): void {
    this.requestGeneration += 1;
    this.picker = undefined;
    this.options.publishRendererState();
  }

  private loadModels(
    threadId: string,
    generation: number,
    cursor: string | null,
    models: Model[],
  ): void {
    this.options.request<ModelListResponse>(
      { method: "model/list", params: { cursor, includeHidden: false } },
      (message) => {
        if (
          generation !== this.requestGeneration ||
          threadId !== this.options.getSelectedThreadId()
        )
          return;
        const page = message.result?.data;
        if (message.error || !Array.isArray(page)) {
          this.options.setCommandNotice("Unable to load available models.");
          this.options.publishRendererState();
          return;
        }
        models.push(...page);
        const nextCursor = message.result?.nextCursor;
        if (typeof nextCursor === "string" && nextCursor) {
          this.loadModels(threadId, generation, nextCursor, models);
          return;
        }
        this.picker = models.length ? { stage: "model", models } : undefined;
        if (!models.length) this.options.setCommandNotice("Unable to load available models.");
        this.options.publishRendererState();
      },
    );
  }
}
