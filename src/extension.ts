import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { accessSync, constants } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { findKeywordHighlights, type HighlightRange } from "./highlight";
import { terminateProcessTree } from "./process";
import { buildQmdArgs, parseQmdOutput, QMD_MODES, type QmdMode, type VectorSearchMode } from "./qmd";

const VIEW_ID = "qmdSearch.view";

interface SearchRequest {
  type: "search";
  query: string;
  mode: QmdMode;
  collections: string[];
}

interface OpenRequest {
  type: "open";
  uri: string;
  line: number;
}

type WebviewRequest = SearchRequest | OpenRequest | { type: "cancel" } | { type: "ready" };

interface SearchResult {
  uri?: string;
  displayPath: string;
  title: string;
  snippet: string;
  line: number;
  score: number;
  titleHighlights: HighlightRange[];
  snippetHighlights: HighlightRange[];
}

interface SearchSummary {
  results: SearchResult[];
  elapsedMs: number;
  warning?: string;
}

interface SearchExecution {
  child: ChildProcess;
  result: Promise<SearchSummary>;
}

interface ResultAppearance {
  fontFamily: string;
  fontSize: number;
  textColor: string;
  linkColor: string;
  borderColor: string;
  snippetLines: number;
  layout: "tall" | "wide";
  compactSpacing: boolean;
  keywordHighlight: "none" | "bold" | "italics";
  keywordHighlightColor: string;
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new QmdSearchViewProvider();

  context.subscriptions.push(
    provider,
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("qmdSearch.focus", async () => {
      await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
      provider.focusInput();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration("qmdSearch.resultFontFamily")
        || event.affectsConfiguration("qmdSearch.resultFontSize")
        || event.affectsConfiguration("qmdSearch.resultTextColor")
        || event.affectsConfiguration("qmdSearch.resultLinkColor")
        || event.affectsConfiguration("qmdSearch.resultBorderColor")
        || event.affectsConfiguration("qmdSearch.snippetLines")
        || event.affectsConfiguration("qmdSearch.resultLayout")
        || event.affectsConfiguration("qmdSearch.compactSpacing")
        || event.affectsConfiguration("qmdSearch.keywordHighlight")
        || event.affectsConfiguration("qmdSearch.keywordHighlightColor")
      ) {
        provider.updateAppearance();
      }
      if (event.affectsConfiguration("qmdSearch.collections")) {
        provider.updateCollections();
      }
    }),
    vscode.window.onDidChangeActiveTextEditor(() => provider.updateCollections()),
  );
}

export function deactivate(): void {}

class QmdSearchViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private searchGeneration = 0;
  private activeSearch?: { child: ChildProcess; generation: number; view: vscode.WebviewView };
  private openableResults = new Set<string>();

  public resolveWebviewView(view: vscode.WebviewView): void {
    this.invalidateSearch();
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = getWebviewHtml(view.webview, getDefaultMode());

    view.webview.onDidReceiveMessage((rawMessage: unknown) => {
      const message = parseWebviewMessage(rawMessage);
      if (!message) {
        void view.webview.postMessage({ type: "error", message: "The QMD Search view sent an invalid request." });
        return;
      }

      if (message.type === "search") {
        void this.search(view, message).catch((error: unknown) => this.reportWebviewError(view, error));
      } else if (message.type === "cancel") {
        this.stopSearch(view);
      } else if (message.type === "open") {
        void this.openResult(message);
      } else if (message.type === "ready") {
        this.focusInput();
        this.updateAppearance();
        this.updateCollections();
      }
    });

    view.onDidDispose(() => {
      if (this.view === view) {
        this.view = undefined;
        this.invalidateSearch();
      }
    });
  }

  public dispose(): void {
    this.view = undefined;
    this.invalidateSearch();
  }

  public focusInput(): void {
    void this.view?.webview.postMessage({ type: "focus" });
  }

  public updateAppearance(): void {
    void this.view?.webview.postMessage({ type: "appearance", appearance: getResultAppearance() });
  }

  public updateCollections(): void {
    void this.view?.webview.postMessage({
      type: "collections",
      collections: getConfiguredCollections(getSearchResource()),
    });
  }

  private async search(view: vscode.WebviewView, request: SearchRequest): Promise<void> {
    const generation = ++this.searchGeneration;
    this.cancelActiveSearch();
    this.openableResults.clear();

    const query = request.query.trim();
    const resource = getSearchResource();
    const mode = request.mode;
    if (!query) {
      await this.postResults(view, generation, { type: "results", query, mode, summary: emptySummary() });
      return;
    }

    const configuredCollections = getConfiguredCollections(resource);
    const collections = configuredCollections.filter((collection) => request.collections.includes(collection));
    if (configuredCollections.length && !collections.length) {
      await this.postResults(view, generation, { type: "results", query, mode, summary: emptySummary() });
      return;
    }
    void this.postIfCurrent(view, generation, { type: "searching", query, mode });

    let execution: SearchExecution | undefined;
    try {
      execution = executeQmdSearch(query, mode, collections, resource);
      this.activeSearch = { child: execution.child, generation, view };
      const summary = await execution.result;
      await this.postResults(view, generation, { type: "results", query, mode, summary });
    } catch (error) {
      await this.postIfCurrent(view, generation, {
        type: "error",
        message: error instanceof Error ? error.message : "The QMD search failed.",
      });
    } finally {
      if (execution && this.activeSearch?.child === execution.child) {
        this.activeSearch = undefined;
      }
    }
  }

  private async postResults(
    view: vscode.WebviewView,
    generation: number,
    message: { type: "results"; query: string; mode: QmdMode; summary: SearchSummary },
  ): Promise<void> {
    if (!this.isCurrent(view, generation)) {
      return;
    }

    this.openableResults = new Set(
      message.summary.results
        .filter((result): result is SearchResult & { uri: string } => Boolean(result.uri))
        .map((result) => resultKey(result.uri, result.line)),
    );
    await view.webview.postMessage(message);
  }

  private async postIfCurrent(view: vscode.WebviewView, generation: number, message: unknown): Promise<void> {
    if (this.isCurrent(view, generation)) {
      await view.webview.postMessage(message);
    }
  }

  private isCurrent(view: vscode.WebviewView, generation: number): boolean {
    return this.view === view && generation === this.searchGeneration;
  }

  private async openResult(request: OpenRequest): Promise<void> {
    try {
      if (!this.openableResults.has(resultKey(request.uri, request.line))) {
        throw new Error("That result is no longer available.");
      }

      const uri = vscode.Uri.parse(request.uri);
      if (uri.scheme !== "file") {
        throw new Error("Only local QMD result files can be opened.");
      }

      const document = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(document, { preview: false });
      const position = document.validatePosition(new vscode.Position(request.line, 0));
      editor.selection = new vscode.Selection(position, position);
      editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not open the search result.";
      void vscode.window.showErrorMessage(`QMD Search: ${message}`);
    }
  }

  private invalidateSearch(): void {
    this.searchGeneration += 1;
    this.openableResults.clear();
    this.cancelActiveSearch();
  }

  private stopSearch(view: vscode.WebviewView): void {
    if (!this.activeSearch || this.activeSearch.view !== view) {
      return;
    }

    this.searchGeneration += 1;
    this.openableResults.clear();
    this.cancelActiveSearch();
    void view.webview.postMessage({ type: "cancelled" });
  }

  private cancelActiveSearch(): void {
    if (this.activeSearch) {
      terminateProcessTree(this.activeSearch.child);
      this.activeSearch = undefined;
    }
  }

  private reportWebviewError(view: vscode.WebviewView, error: unknown): void {
    if (this.view === view) {
      const message = error instanceof Error ? error.message : "The QMD search failed.";
      void view.webview.postMessage({ type: "error", message });
    }
  }
}

function executeQmdSearch(
  query: string,
  mode: QmdMode,
  collections: string[],
  resource?: vscode.Uri,
): SearchExecution {
  const configuration = vscode.workspace.getConfiguration("qmdSearch", resource);
  const configuredExecutable = configuration.get<string>("executablePath", "qmd").trim() || "qmd";
  const executable = resolveQmdExecutable(configuredExecutable);
  const maxResults = Math.floor(clamp(configuration.get<number>("maxResults", 20), 1, 1000));
  const index = configuration.get<string>("index", "").trim();
  const vectorSearchMode: VectorSearchMode = configuration.get<string>("vectorSearchMode", "single") === "expanded"
    ? "expanded"
    : "single";
  const cwd = resource?.scheme === "file" ? resource.fsPath : os.homedir();
  const args = buildQmdArgs({ query, mode, vectorSearchMode, collections, index, maxResults });

  const startedAt = Date.now();
  const executableDirectory = path.isAbsolute(executable) ? path.dirname(executable) : undefined;
  const childPath = [executableDirectory, process.env.PATH].filter(Boolean).join(path.delimiter);
  const child = spawn(
    executable,
    args,
    {
      cwd,
      env: { ...process.env, PATH: childPath, NO_COLOR: "1" },
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const result = new Promise<SearchSummary>((resolve, reject) => {
    const maxBuffer = 8 * 1024 * 1024;
    let stdout = "";
    let stderr = "";
    let settled = false;

    const fail = (error: Error): void => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };
    const appendOutput = (current: string, chunk: string): string => {
      if (settled) {
        return current;
      }
      const next = current + chunk;
      if (Buffer.byteLength(next, "utf8") > maxBuffer) {
        terminateProcessTree(child);
        fail(new Error("QMD produced more than 8 MB of output. Reduce qmdSearch.maxResults."));
      }
      return next;
    };

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { stdout = appendOutput(stdout, chunk); });
    child.stderr?.on("data", (chunk: string) => { stderr = appendOutput(stderr, chunk); });
    child.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        fail(new Error(`Cannot find '${executable}'. Set qmdSearch.executablePath to the QMD executable.`));
      } else {
        fail(error);
      }
    });
    child.once("close", (code, signal) => {
      if (settled) {
        return;
      }
      if (code !== 0) {
        const detail = stderr.trim() || `QMD exited with ${signal ? `signal ${signal}` : `code ${code ?? "unknown"}`}.`;
        fail(new Error(detail.replace(/^Error:\s*/i, "")));
        return;
      }

      try {
        const parsed = parseQmdOutput(stdout);
        settled = true;
        resolve({
          results: parsed.items.map((item, index) => addHighlights(mapQmdResult(item, cwd, index), query, mode)),
          elapsedMs: Date.now() - startedAt,
          warning: combineWarnings(parsed.notice, extractQmdWarning(stderr)),
        });
      } catch (parseError) {
        const detail = parseError instanceof Error ? parseError.message : "Invalid JSON.";
        const excerpt = stdout.trim().slice(0, 300);
        fail(new Error(`Could not read QMD's JSON output: ${detail}${excerpt ? `\n${excerpt}` : ""}`));
      }
    });
  });

  return { child, result };
}

function resolveQmdExecutable(configured: string): string {
  if (configured !== "qmd") {
    return configured.startsWith(`~${path.sep}`)
      ? path.join(os.homedir(), configured.slice(2))
      : configured;
  }

  const candidates = [
    ...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean).map((directory) => path.join(directory, "qmd")),
    path.join(os.homedir(), ".bun", "bin", "qmd"),
    path.join(os.homedir(), ".local", "bin", "qmd"),
    path.join(os.homedir(), ".npm-global", "bin", "qmd"),
  ];

  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue through known user-level install locations.
    }
  }

  return configured;
}

function mapQmdResult(value: unknown, cwd: string, index: number): SearchResult {
  if (!isRecord(value)) {
    throw new Error(`QMD result ${index + 1} was not an object.`);
  }

  const result = value;
  const file = typeof result.file === "string" ? result.file : "";
  if (!file) {
    throw new Error(`QMD result ${index + 1} did not include a source file.`);
  }

  const sourceLine = typeof result.line === "number" && Number.isFinite(result.line) ? result.line : 1;
  const line = Math.max(0, Math.floor(sourceLine) - 1);
  const score = typeof result.score === "number" && Number.isFinite(result.score) ? result.score : 0;
  const title = typeof result.title === "string" && result.title ? result.title : path.basename(file);
  const rawSnippet = typeof result.snippet === "string"
    ? result.snippet
    : typeof result.body === "string"
      ? result.body
      : "";

  if (file.startsWith("qmd://")) {
    return {
      displayPath: file,
      title,
      snippet: cleanSnippet(rawSnippet),
      line,
      score,
      titleHighlights: [],
      snippetHighlights: [],
    };
  }

  const fullPath = path.isAbsolute(file) ? file : path.resolve(cwd, file);
  const uri = vscode.Uri.file(fullPath);

  return {
    uri: uri.toString(),
    displayPath: displayPath(uri),
    title,
    snippet: cleanSnippet(rawSnippet),
    line,
    score,
    titleHighlights: [],
    snippetHighlights: [],
  };
}

function addHighlights(result: SearchResult, query: string, mode: QmdMode): SearchResult {
  return {
    ...result,
    titleHighlights: findKeywordHighlights(result.title, query, mode),
    snippetHighlights: findKeywordHighlights(result.snippet, query, mode),
  };
}

function cleanSnippet(snippet: string): string {
  return snippet
    .replace(/^@@[^\r\n]*(?:\r?\n)?/, "")
    .replace(/^(?:\r?\n)+/, "")
    .replace(/(?:\r?\n)+$/, "");
}

function extractQmdWarning(stderr: string): string | undefined {
  const warningLines = stderr
    .split(/\r?\n/)
    .filter((line) => /warn|failed|unavailable|pending embeddings|need embeddings|last updated|qmd update|^tip:/i.test(line));
  return warningLines.length ? warningLines.join("\n") : undefined;
}

function combineWarnings(...warnings: Array<string | undefined>): string | undefined {
  const combined = warnings.map((warning) => warning?.trim()).filter(Boolean).join("\n");
  return combined || undefined;
}

function parseWebviewMessage(value: unknown): WebviewRequest | undefined {
  if (!isRecord(value) || typeof value.type !== "string") {
    return undefined;
  }

  if (value.type === "ready") {
    return { type: "ready" };
  }
  if (value.type === "cancel") {
    return { type: "cancel" };
  }
  if (
    value.type === "search"
    && typeof value.query === "string"
    && typeof value.mode === "string"
    && QMD_MODES.includes(value.mode as QmdMode)
    && Array.isArray(value.collections)
    && value.collections.every((collection) => typeof collection === "string")
  ) {
    return {
      type: "search",
      query: value.query,
      mode: value.mode as QmdMode,
      collections: value.collections,
    };
  }
  if (
    value.type === "open"
    && typeof value.uri === "string"
    && Number.isInteger(value.line)
    && typeof value.line === "number"
    && value.line >= 0
  ) {
    return { type: "open", uri: value.uri, line: value.line };
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function resultKey(uri: string, line: number): string {
  return `${uri}\0${line}`;
}

function displayPath(uri: vscode.Uri): string {
  const relative = vscode.workspace.asRelativePath(uri, false);
  if (relative !== uri.fsPath) {
    return relative;
  }

  const home = os.homedir();
  return uri.fsPath.startsWith(`${home}${path.sep}`) ? `~${uri.fsPath.slice(home.length)}` : uri.fsPath;
}

function getDefaultMode(): QmdMode {
  const configured = vscode.workspace.getConfiguration("qmdSearch").get<string>("defaultMode", "query");
  return QMD_MODES.includes(configured as QmdMode) ? configured as QmdMode : "query";
}

function getConfiguredCollections(resource?: vscode.Uri): string[] {
  const configured = vscode.workspace.getConfiguration("qmdSearch", resource).get<string[]>("collections", []);
  return [...new Set(configured.map((collection) => collection.trim()).filter(Boolean))].slice(0, 5);
}

function getSearchResource(): vscode.Uri | undefined {
  const activeDocument = vscode.window.activeTextEditor?.document.uri;
  const activeFolder = activeDocument ? vscode.workspace.getWorkspaceFolder(activeDocument) : undefined;
  return activeFolder?.uri ?? vscode.workspace.workspaceFolders?.[0]?.uri;
}

function getResultAppearance(): ResultAppearance {
  const configuration = vscode.workspace.getConfiguration("qmdSearch");
  const configuredFamily = configuration.get<string>("resultFontFamily", "").trim();
  const configuredLayout = configuration.get<string>("resultLayout", "tall");
  const configuredHighlight = configuration.get<string>("keywordHighlight", "bold");

  return {
    fontFamily: configuredFamily || "var(--vscode-editor-font-family)",
    fontSize: clamp(configuration.get<number>("resultFontSize", 12), 8, 32),
    textColor: getHexColor(configuration, "resultTextColor"),
    linkColor: getHexColor(configuration, "resultLinkColor"),
    borderColor: getHexColor(configuration, "resultBorderColor"),
    snippetLines: clamp(configuration.get<number>("snippetLines", 5), 1, 50),
    layout: configuredLayout === "wide" ? "wide" : "tall",
    compactSpacing: configuration.get<boolean>("compactSpacing", false),
    keywordHighlight: configuredHighlight === "none" || configuredHighlight === "italics"
      ? configuredHighlight
      : "bold",
    keywordHighlightColor: getHexColor(configuration, "keywordHighlightColor"),
  };
}

function getHexColor(configuration: vscode.WorkspaceConfiguration, key: string): string {
  const value = configuration.get<string>(key, "").trim();
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value) ? value : "";
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function emptySummary(): SearchSummary {
  return { results: [], elapsedMs: 0 };
}

function getWebviewHtml(webview: vscode.Webview, defaultMode: QmdMode): string {
  const nonce = getNonce();

  return /* html */ `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; form-action 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <title>QMD Search</title>
  <style nonce="${nonce}">
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
    .search-shell {
      position: sticky;
      z-index: 2;
      top: 0;
      padding: 12px 12px 10px;
      border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, transparent);
      background: var(--vscode-sideBar-background);
    }
    .search-box {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      overflow: hidden;
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 7px;
      background: var(--vscode-input-background);
      box-shadow: 0 2px 8px rgb(0 0 0 / 12%);
    }
    .search-box:focus-within {
      border-color: var(--vscode-focusBorder);
      box-shadow: 0 0 0 1px var(--vscode-focusBorder);
    }
    #query {
      min-width: 0;
      height: 34px;
      padding: 0 10px;
      border: 0;
      outline: 0;
      color: var(--vscode-input-foreground);
      background: transparent;
      font: inherit;
    }
    #query::placeholder { color: var(--vscode-input-placeholderForeground); }
    .submit {
      margin: 4px;
      padding: 0 10px;
      border: 0;
      border-radius: 4px;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      font: 600 11px/1 var(--vscode-font-family);
      cursor: pointer;
    }
    .submit:hover { background: var(--vscode-button-hoverBackground); }
    .submit:disabled { cursor: wait; opacity: .6; }
    .submit.stop {
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
    }
    .submit.stop:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .modes {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 3px;
      margin-top: 8px;
      padding: 3px;
      border-radius: 6px;
      background: var(--vscode-editorWidget-background, var(--vscode-input-background));
    }
    .mode {
      min-width: 0;
      height: 25px;
      padding: 0 4px;
      border: 0;
      border-radius: 4px;
      color: var(--vscode-descriptionForeground);
      background: transparent;
      font: 500 10px/1 var(--vscode-font-family);
      cursor: pointer;
    }
    .mode:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground); }
    .mode.active {
      color: var(--vscode-inputOption-activeForeground, var(--vscode-foreground));
      background: var(--vscode-inputOption-activeBackground, var(--vscode-list-activeSelectionBackground));
      outline: 1px solid var(--vscode-inputOption-activeBorder, transparent);
    }
    .collections {
      display: flex;
      flex-wrap: wrap;
      gap: 4px 9px;
      margin-top: 7px;
    }
    .collections[hidden] { display: none; }
    .collection-option {
      display: flex;
      min-width: 0;
      align-items: center;
      gap: 4px;
      color: var(--vscode-descriptionForeground);
      font: 500 10px/1.2 var(--vscode-font-family);
      cursor: pointer;
    }
    .collection-option:hover { color: var(--vscode-foreground); }
    .collection-option input {
      width: 12px;
      height: 12px;
      margin: 0;
      accent-color: var(--vscode-focusBorder);
      cursor: pointer;
    }
    .collection-option span {
      max-width: 110px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .meta {
      min-height: 22px;
      padding: 7px 2px 0;
      overflow: hidden;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .warning {
      margin-top: 5px;
      color: var(--vscode-editorWarning-foreground, var(--vscode-descriptionForeground));
      font-size: 11px;
      line-height: 1.35;
      white-space: pre-wrap;
    }
    .warning[hidden] { display: none; }
    .results {
      --qmd-result-font-family: var(--vscode-editor-font-family);
      --qmd-result-font-size: 12px;
      padding: 10px 8px 18px;
    }
    .hit {
      display: block;
      position: relative;
      width: 100%;
      margin: 0 0 7px;
      padding: 10px 10px 9px 12px;
      overflow: hidden;
      border: 1px solid var(--qmd-result-border-color, var(--vscode-widget-border, transparent));
      border-radius: 7px;
      color: var(--qmd-result-text-color, var(--vscode-foreground));
      background: var(--vscode-editorWidget-background, transparent);
      font-family: var(--qmd-result-font-family);
      font-size: var(--qmd-result-font-size);
      text-align: left;
      cursor: pointer;
    }
    .hit::before {
      position: absolute;
      top: 0;
      bottom: 0;
      left: 0;
      width: 3px;
      background: var(--vscode-charts-blue);
      content: "";
    }
    .hit:hover { border-color: var(--qmd-result-border-color, var(--vscode-focusBorder)); background: var(--vscode-list-hoverBackground); }
    .hit:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
    .hit[aria-disabled="true"] { cursor: not-allowed; opacity: .65; }
    .hit-topline {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 5px;
      color: var(--qmd-result-text-color, var(--vscode-descriptionForeground));
      font-size: .82em;
      font-variant-numeric: tabular-nums;
    }
    .rank { font-weight: 650; letter-spacing: .04em; text-transform: uppercase; }
    .score { flex: none; }
    .title {
      margin-bottom: 3px;
      overflow: hidden;
      font-size: 1em;
      font-weight: 650;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .source {
      margin-bottom: 7px;
      overflow: hidden;
      color: var(--qmd-result-link-color, var(--vscode-textLink-foreground));
      font-size: .82em;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .snippet {
      display: -webkit-box;
      overflow: hidden;
      color: var(--qmd-result-text-color, var(--vscode-foreground));
      font-family: inherit;
      font-size: 1em;
      line-height: 1.45;
      overflow-wrap: anywhere;
      white-space: pre-wrap;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 5;
    }
    .results.keyword-highlight-bold .keyword-highlight,
    .results.keyword-highlight-italics .keyword-highlight {
      color: var(--qmd-keyword-highlight-color, inherit);
    }
    .results.keyword-highlight-bold .keyword-highlight { font-weight: 700; }
    .results.keyword-highlight-italics .keyword-highlight { font-style: italic; }
    .results.layout-wide .hit {
      display: grid;
      grid-template-areas:
        "rank title score"
        "source source source"
        "snippet snippet snippet";
      grid-template-columns: auto minmax(0, 1fr) auto;
      column-gap: 7px;
      align-items: center;
    }
    .results.layout-wide .hit-topline { display: contents; }
    .results.layout-wide .rank { grid-area: rank; }
    .results.layout-wide .score { grid-area: score; }
    .results.layout-wide .title {
      grid-area: title;
      margin: 0;
    }
    .results.layout-wide .source {
      grid-area: source;
      margin: 2px 0 0;
    }
    .results.layout-wide .snippet {
      grid-area: snippet;
      margin-top: 7px;
    }
    .results.compact { padding-top: 5px; }
    .results.compact .hit {
      margin-bottom: 3px;
      padding: 6px 8px 6px 10px;
    }
    .results.compact .hit-topline { margin-bottom: 2px; }
    .results.compact .title { margin-bottom: 1px; }
    .results.compact .source { margin-bottom: 3px; }
    .results.compact .snippet { line-height: 1.25; }
    .results.compact.layout-wide .source { margin-bottom: 0; }
    .results.compact.layout-wide .snippet { margin-top: 3px; }
    .empty {
      display: grid;
      min-height: 210px;
      place-content: center;
      padding: 28px;
      color: var(--vscode-descriptionForeground);
      text-align: center;
    }
    .empty-symbol {
      position: relative;
      width: 42px;
      height: 42px;
      margin: 0 auto 12px;
      border: 2px solid currentColor;
      border-radius: 50%;
      opacity: .38;
    }
    .empty-symbol::after {
      position: absolute;
      right: -10px;
      bottom: 0;
      width: 15px;
      height: 2px;
      transform: rotate(45deg);
      border-radius: 2px;
      background: currentColor;
      content: "";
    }
    .empty strong { margin-bottom: 5px; color: var(--vscode-foreground); font-size: 13px; }
    .error { color: var(--vscode-errorForeground); }
    .pulse { animation: pulse 1.1s ease-in-out infinite; }
    @keyframes pulse { 50% { opacity: .45; } }
    @media (prefers-reduced-motion: reduce) {
      .pulse { animation: none; }
    }
  </style>
</head>
<body>
  <header class="search-shell">
    <form id="search-form" class="search-box">
      <input id="query" type="search" placeholder="Search your QMD index" aria-label="Search your QMD index" autocomplete="off" spellcheck="false">
      <button id="submit" class="submit" type="submit" disabled>Search</button>
    </form>
    <div class="modes" role="group" aria-label="QMD search mode">
      <button class="mode" data-mode="query" type="button" title="Hybrid search with expansion and reranking">Hybrid</button>
      <button class="mode" data-mode="search" type="button" title="Fast BM25 full-text search">Keyword</button>
      <button class="mode" data-mode="vsearch" type="button" title="Vector similarity search">Vector</button>
    </div>
    <div id="collections" class="collections" role="group" aria-label="QMD collections" hidden></div>
    <div id="status" class="meta" role="status" aria-live="polite" aria-atomic="true">Search all indexed QMD collections</div>
    <div id="warning" class="warning" role="status" aria-live="polite" aria-atomic="true" hidden></div>
  </header>
  <main id="results" class="results">
    <div class="empty"><div class="empty-symbol"></div><strong>Query your knowledge base</strong><span>Ranked QMD results will appear here.</span></div>
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const searchForm = document.getElementById("search-form");
    const queryInput = document.getElementById("query");
    const submitButton = document.getElementById("submit");
    const modeButtons = Array.from(document.querySelectorAll(".mode"));
    const collectionPicker = document.getElementById("collections");
    const status = document.getElementById("status");
    const warning = document.getElementById("warning");
    const results = document.getElementById("results");
    const previousState = vscode.getState() || {};
    let snippetLines = 5;
    let availableCollections = [];
    let collectionsReady = false;
    let searching = false;
    let selectedCollections = Array.isArray(previousState.collections) ? previousState.collections : null;
    let mode = ["query", "search", "vsearch"].includes(previousState.mode)
      ? previousState.mode
      : ${JSON.stringify(defaultMode)};

    queryInput.value = previousState.query || "";
    setMode(mode);

    function setMode(nextMode) {
      mode = nextMode;
      for (const button of modeButtons) {
        const active = button.dataset.mode === mode;
        button.classList.toggle("active", active);
        button.setAttribute("aria-pressed", String(active));
      }
      persistState();
    }

    function persistState() {
      vscode.setState({
        query: queryInput.value,
        mode,
        collections: selectedCollections,
      });
    }

    function runSearch() {
      if (!collectionsReady || searching) return;
      const query = queryInput.value.trim();
      persistState();
      if (availableCollections.length && !selectedCollections.length) {
        status.textContent = "Select at least one QMD collection";
        status.className = "meta error";
        renderEmpty("No collection selected", "Select one or more collections, then search again.", true);
        return;
      }
      searching = true;
      updateSearchButton();
      status.textContent = modeLabel(mode) + " search starting...";
      status.className = "meta pulse";
      vscode.postMessage({ type: "search", query, mode, collections: selectedCollections || [] });
    }

    queryInput.addEventListener("input", persistState);
    searchForm.addEventListener("submit", (event) => {
      event.preventDefault();
      if (searching) {
        submitButton.disabled = true;
        submitButton.textContent = "Stopping...";
        status.textContent = "Stopping QMD search...";
        status.className = "meta pulse";
        vscode.postMessage({ type: "cancel" });
        return;
      }
      runSearch();
    });
    for (const button of modeButtons) {
      button.addEventListener("click", () => setMode(button.dataset.mode));
    }

    window.addEventListener("message", (event) => {
      const message = event.data;
      if (message.type === "focus") {
        queryInput.focus();
        queryInput.select();
      } else if (message.type === "searching") {
        searching = true;
        updateSearchButton();
        warning.hidden = true;
        status.textContent = modeLabel(message.mode) + " search running...";
        status.className = "meta pulse";
      } else if (message.type === "cancelled") {
        searching = false;
        updateSearchButton();
        warning.hidden = true;
        status.textContent = "Search stopped";
        status.title = "";
        status.className = "meta";
        renderEmpty("Search stopped", "The running QMD process was terminated.");
      } else if (message.type === "results") {
        searching = false;
        updateSearchButton();
        renderResults(message.query, message.mode, message.summary);
      } else if (message.type === "error") {
        searching = false;
        updateSearchButton();
        warning.hidden = true;
        status.textContent = message.message;
        status.title = message.message;
        status.className = "meta error";
        renderEmpty("QMD search failed", message.message, true);
      } else if (message.type === "appearance") {
        applyAppearance(message.appearance);
      } else if (message.type === "collections") {
        applyCollections(message.collections);
      }
    });

    function applyCollections(collections) {
      availableCollections = collections;
      const retained = selectedCollections === null
        ? collections
        : selectedCollections.filter((collection) => collections.includes(collection));
      selectedCollections = retained;
      collectionsReady = true;
      updateSearchButton();
      collectionPicker.replaceChildren();
      collectionPicker.hidden = !collections.length;

      for (const collection of collections) {
        const label = document.createElement("label");
        label.className = "collection-option";
        label.title = collection;
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = selectedCollections.includes(collection);
        checkbox.value = collection;
        const name = document.createElement("span");
        name.textContent = collection;
        checkbox.addEventListener("change", () => {
          selectedCollections = Array.from(collectionPicker.querySelectorAll("input:checked"), (input) => input.value);
          persistState();
        });
        label.append(checkbox, name);
        collectionPicker.append(label);
      }
      persistState();
    }

    function updateSearchButton() {
      submitButton.disabled = !searching && !collectionsReady;
      submitButton.textContent = searching ? "Stop" : "Search";
      submitButton.title = searching ? "Stop the running QMD search" : "";
      submitButton.classList.toggle("stop", searching);
    }

    function applyAppearance(appearance) {
      results.style.setProperty("--qmd-result-font-family", appearance.fontFamily);
      results.style.setProperty("--qmd-result-font-size", appearance.fontSize + "px");
      setOptionalStyleProperty("--qmd-result-text-color", appearance.textColor);
      setOptionalStyleProperty("--qmd-result-link-color", appearance.linkColor);
      setOptionalStyleProperty("--qmd-result-border-color", appearance.borderColor);
      results.classList.toggle("layout-wide", appearance.layout === "wide");
      results.classList.toggle("compact", appearance.compactSpacing);
      results.classList.toggle("keyword-highlight-bold", appearance.keywordHighlight === "bold");
      results.classList.toggle("keyword-highlight-italics", appearance.keywordHighlight === "italics");
      setOptionalStyleProperty("--qmd-keyword-highlight-color", appearance.keywordHighlightColor);
      snippetLines = appearance.snippetLines;
      for (const snippet of results.querySelectorAll(".snippet")) {
        snippet.style.webkitLineClamp = String(snippetLines);
      }
    }

    function setOptionalStyleProperty(name, value) {
      if (value) {
        results.style.setProperty(name, value);
      } else {
        results.style.removeProperty(name);
      }
    }

    function modeLabel(value) {
      return value === "query" ? "Hybrid" : value === "search" ? "Keyword" : "Vector";
    }

    function renderResults(query, resultMode, summary) {
      status.className = "meta";
      status.title = "";
      warning.textContent = summary.warning || "";
      warning.hidden = !summary.warning;
      if (!query) {
        status.textContent = "Search all indexed QMD collections";
        renderEmpty("Query your knowledge base", "Ranked QMD results will appear here.");
        return;
      }

      const count = summary.results.length;
      const seconds = (summary.elapsedMs / 1000).toFixed(summary.elapsedMs < 1000 ? 2 : 1);
      status.textContent = count + " result" + (count === 1 ? "" : "s") + " via " + modeLabel(resultMode) + " in " + seconds + "s";

      if (!count) {
        renderEmpty("No results", "Try another query or a different QMD search mode.");
        return;
      }

      results.replaceChildren();
      summary.results.forEach((hit, index) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "hit";
        button.setAttribute("aria-disabled", String(!hit.uri));
        if (!hit.uri) {
          button.setAttribute("aria-label", hit.title + ". Source unavailable. Run qmd update.");
        }
        button.title = hit.uri
          ? "Open " + hit.displayPath + " at line " + (hit.line + 1)
          : "The indexed source no longer resolves to a file. Run qmd update.";

        const topline = document.createElement("div");
        topline.className = "hit-topline";
        const rank = document.createElement("span");
        rank.className = "rank";
        rank.textContent = "Result " + (index + 1);
        const score = document.createElement("span");
        score.className = "score";
        score.textContent = Math.round(hit.score * 100) + "%";
        topline.append(rank, score);

        const title = document.createElement("div");
        title.className = "title";
        appendHighlightedText(title, hit.title, hit.titleHighlights);

        const source = document.createElement("div");
        source.className = "source";
        source.textContent = hit.displayPath + " : " + (hit.line + 1);

        button.append(topline, title, source);
        if (hit.snippet) {
          const snippet = document.createElement("div");
          snippet.className = "snippet";
          snippet.style.webkitLineClamp = String(snippetLines);
          appendHighlightedText(snippet, hit.snippet, hit.snippetHighlights);
          button.append(snippet);
        }
        if (hit.uri) {
          button.addEventListener("click", () => vscode.postMessage({
            type: "open",
            uri: hit.uri,
            line: hit.line,
          }));
        }
        results.append(button);
      });
    }

    function appendHighlightedText(element, text, ranges) {
      let offset = 0;
      for (const range of ranges || []) {
        element.append(document.createTextNode(text.slice(offset, range.start)));
        const highlight = document.createElement("span");
        highlight.className = "keyword-highlight";
        highlight.textContent = text.slice(range.start, range.end);
        element.append(highlight);
        offset = range.end;
      }
      element.append(document.createTextNode(text.slice(offset)));
    }

    function renderEmpty(title, message, isError = false) {
      results.replaceChildren();
      const empty = document.createElement("div");
      empty.className = "empty" + (isError ? " error" : "");
      const symbol = document.createElement("div");
      symbol.className = "empty-symbol";
      const strong = document.createElement("strong");
      strong.textContent = title;
      const detail = document.createElement("span");
      detail.textContent = message;
      empty.append(symbol, strong, detail);
      results.append(empty);
    }

    vscode.postMessage({ type: "ready" });
  </script>
</body>
</html>`;
}

function getNonce(): string {
  return randomBytes(24).toString("base64");
}
