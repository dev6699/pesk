import { matchesShortcut } from "../../shared/shortcuts.js";

const slashCommands = [
  { command: "/plan", description: "Switch to Plan mode" },
  { command: "/goal", description: "Usage: /goal [<objective>|clear|edit|pause|resume]" },
  { command: "/project", description: "Manage projects" },
  { command: "/default", description: "Switch to Default mode" },
  { command: "/new", description: "Start a new Codex session" },
  { command: "/fork", description: "Fork the current session" },
  { command: "/archive", description: "Archive the current session" },
  { command: "/delete", description: "Permanently delete the current session" },
  { command: "/review", description: "Review current changes" },
  { command: "/exec", description: "Run a sandboxed command" },
];

export class CodexSuggestionRenderer {
  private readonly input: HTMLTextAreaElement;
  private suggestionInput: HTMLTextAreaElement;
  private fileSearchSerial = 0;
  private fileSuggestionResults: FuzzyFileSearchResult[] = [];
  private slashCommandResults: typeof slashCommands = [];
  private suggestionKind: "file" | "command" | undefined;
  private fileSuggestionIndex = -1;

  constructor(
    input: HTMLTextAreaElement,
    private readonly fileSuggestions: HTMLElement,
    private readonly getWorkingDirectory: () => string | undefined,
    private readonly onResize: () => void,
    private readonly onCommandMode: () => void,
  ) {
    this.input = input;
    this.suggestionInput = input;
  }

  hasSuggestions(): boolean {
    return this.suggestionKind === "command"
      ? this.slashCommandResults.length > 0
      : this.fileSuggestionResults.length > 0;
  }

  private suggestionCount(): number {
    return this.suggestionKind === "command"
      ? this.slashCommandResults.length
      : this.fileSuggestionResults.length;
  }

  select(index: number): void {
    this.selectSuggestion(index);
  }

  selectCurrent(): void {
    this.selectSuggestion(this.fileSuggestionIndex);
  }

  hide(): void {
    this.hideFileSuggestions();
  }

  /** Handles keyboard navigation within the suggestion list. */
  handleSuggestionKeydown(event: KeyboardEvent): boolean {
    if (!this.suggestionCount()) return false;
    if (matchesShortcut(event, "suggestionNext") || matchesShortcut(event, "suggestionPrevious")) {
      event.preventDefault();
      const direction = matchesShortcut(event, "suggestionNext") ? 1 : -1;
      const suggestionCount = this.suggestionCount();
      this.fileSuggestionIndex =
        (this.fileSuggestionIndex + direction + suggestionCount) % suggestionCount;
      this.renderFileSuggestions();
      return true;
    }
    if (matchesShortcut(event, "submit")) {
      event.preventDefault();
      this.selectSuggestion(this.fileSuggestionIndex);
      return true;
    }
    if (matchesShortcut(event, "dismissSuggestions")) {
      event.preventDefault();
      this.hideFileSuggestions();
      return true;
    }
    return false;
  }

  /** Updates file and slash-command suggestions for the prompt input. */
  async updateSuggestions(
    input: HTMLTextAreaElement = this.suggestionInput,
    allowCommands = true,
  ): Promise<void> {
    this.suggestionInput = input;
    const cursor = input.selectionStart ?? input.value.length;
    const beforeCursor = input.value.slice(0, cursor);
    const commandMatch = beforeCursor.match(/^\/([^\s]*)$/);
    if (allowCommands && commandMatch) {
      const query = commandMatch[1].toLowerCase();
      this.fileSearchSerial += 1;
      this.suggestionKind = "command";
      this.slashCommandResults = slashCommands.filter(({ command }) =>
        command.slice(1).startsWith(query),
      );
      this.fileSuggestionIndex = this.slashCommandResults.length ? 0 : -1;
      this.renderFileSuggestions();
      return;
    }
    const match = beforeCursor.match(/(?:^|\s)@([^\s]*)$/);
    if (!match) {
      this.hideFileSuggestions();
      return;
    }
    const query = match[1];
    if (!query) {
      this.hideFileSuggestions();
      return;
    }
    const serial = ++this.fileSearchSerial;
    const cwd = this.getWorkingDirectory();
    const results = await window.peskApi.fuzzyFileSearch(query, cwd ? [cwd] : []);
    if (serial !== this.fileSearchSerial) return;
    this.suggestionKind = "file";
    this.fileSuggestionResults = results.slice(0, 8);
    this.fileSuggestionIndex = this.fileSuggestionResults.length ? 0 : -1;
    this.renderFileSuggestions();
  }

  /** Renders the currently available prompt suggestions. */
  private renderFileSuggestions(): void {
    this.fileSuggestions.replaceChildren();
    const results =
      this.suggestionKind === "command" ? this.slashCommandResults : this.fileSuggestionResults;
    this.fileSuggestions.hidden = !results.length;
    if (this.suggestionKind === "command") {
      this.slashCommandResults.forEach((result, index) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "codex-file-suggestion codex-command-suggestion";
        button.setAttribute("role", "option");
        button.setAttribute("aria-selected", String(index === this.fileSuggestionIndex));
        const name = document.createElement("span");
        name.className = "codex-file-suggestion-name";
        name.textContent = result.command;
        const description = document.createElement("span");
        description.className = "codex-file-suggestion-path";
        description.textContent = result.description;
        button.append(name, description);
        button.title = result.description;
        button.addEventListener("mousedown", (event) => event.preventDefault());
        button.addEventListener("click", () => this.selectSuggestion(index));
        this.fileSuggestions.append(button);
        if (index === this.fileSuggestionIndex) {
          this.scrollSuggestionIntoView(button);
        }
      });
      return;
    }
    this.fileSuggestionResults.forEach((result, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "codex-file-suggestion";
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", String(index === this.fileSuggestionIndex));
      const name = document.createElement("span");
      name.className = "codex-file-suggestion-name";
      name.textContent = result.file_name;
      const separatorIndex = Math.max(result.path.lastIndexOf("/"), result.path.lastIndexOf("\\"));
      const parentPath = document.createElement("span");
      parentPath.className = "codex-file-suggestion-path";
      parentPath.textContent = separatorIndex >= 0 ? result.path.slice(0, separatorIndex) : ".";
      const matchType = document.createElement("span");
      matchType.className = "codex-file-suggestion-type";
      matchType.textContent = result.match_type;
      button.append(name, parentPath, matchType);
      button.title = result.path;
      button.addEventListener("mousedown", (event) => event.preventDefault());
      button.addEventListener("click", () => this.selectSuggestion(index));
      this.fileSuggestions.append(button);
      if (index === this.fileSuggestionIndex) {
        this.scrollSuggestionIntoView(button);
      }
    });
  }

  /** Scrolls the active suggestion into the visible list area. */
  private scrollSuggestionIntoView(button: HTMLElement): void {
    button.scrollIntoView?.({ block: "nearest" });
    const top = button.offsetTop;
    const bottom = top + button.offsetHeight;
    if (top < this.fileSuggestions.scrollTop) {
      this.fileSuggestions.scrollTop = top;
    } else if (bottom > this.fileSuggestions.scrollTop + this.fileSuggestions.clientHeight) {
      this.fileSuggestions.scrollTop = bottom - this.fileSuggestions.clientHeight;
    }
  }

  /** Inserts the selected suggestion into the prompt input. */
  private selectSuggestion(index: number): void {
    const input = this.suggestionInput;
    if (this.suggestionKind === "command") {
      const result = this.slashCommandResults[index];
      if (!result) return;
      input.value = `${result.command} `;
      input.selectionStart = input.value.length;
      input.selectionEnd = input.value.length;
      this.hideFileSuggestions();
      if (input === this.input) {
        this.onResize();
        this.onCommandMode();
      }
      input.focus();
      return;
    }
    const result = this.fileSuggestionResults[index];
    if (!result) return;
    const cursor = input.selectionStart ?? input.value.length;
    const beforeCursor = input.value.slice(0, cursor);
    const match = beforeCursor.match(/(?:^|\s)@([^\s]*)$/);
    if (!match) {
      this.hideFileSuggestions();
      return;
    }
    const tokenStart = cursor - match[1].length - 1;
    input.value = `${input.value.slice(0, tokenStart)}${result.path} ${input.value.slice(cursor)}`;
    const nextCursor = tokenStart + result.path.length + 1;
    input.selectionStart = nextCursor;
    input.selectionEnd = nextCursor;
    this.hideFileSuggestions();
    if (input === this.input) this.onResize();
    input.focus();
  }

  /** Clears and hides all prompt suggestions. */
  private hideFileSuggestions(): void {
    this.fileSearchSerial += 1;
    this.fileSuggestionResults = [];
    this.slashCommandResults = [];
    this.suggestionKind = undefined;
    this.fileSuggestionIndex = -1;
    this.fileSuggestions.hidden = true;
    this.fileSuggestions.replaceChildren();
  }
}
