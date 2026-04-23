import { LSPPlugin, Workspace, type WorkspaceFile } from "@codemirror/lsp-client";
import { ChangeSet, EditorState, Text, type TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { LSPClient } from "@codemirror/lsp-client";

export interface LeanWorkspaceLoadResult {
  doc: string | Text;
  languageId?: string;
  version?: number;
}

export interface LeanWorkspaceOptions {
  loadDocument?: (
    uri: string,
  ) =>
    | Promise<LeanWorkspaceLoadResult | string | Text | null>
    | LeanWorkspaceLoadResult
    | string
    | Text
    | null;
  displayDocument?: (
    uri: string,
    workspace: LeanWorkspace,
  ) => Promise<EditorView | null> | EditorView | null;
  onDocumentChange?: (
    uri: string,
    file: LeanWorkspaceFile,
    update: TransactionSpec,
  ) => Promise<void> | void;
  resolveLanguageId?: (uri: string) => string;
}

function toText(doc: string | Text): Text {
  return typeof doc === "string" ? Text.of(doc.split(/\r?\n/u)) : doc;
}

function normalizeLoadedDocument(
  value: LeanWorkspaceLoadResult | string | Text,
): LeanWorkspaceLoadResult {
  if (typeof value === "string" || value instanceof Text) {
    return { doc: value };
  }
  return value;
}

export class LeanWorkspaceFile implements WorkspaceFile {
  serverOpen = false;
  readonly views = new Set<EditorView>();

  constructor(
    readonly uri: string,
    public languageId: string,
    public version: number,
    public doc: Text,
  ) {}

  getView(main?: EditorView): EditorView | null {
    if (main && this.views.has(main)) {
      return main;
    }
    return this.views.values().next().value ?? null;
  }

  hasOpenView(): boolean {
    return this.views.size > 0;
  }
}

export class LeanWorkspace extends Workspace {
  readonly files: LeanWorkspaceFile[] = [];
  private readonly fileVersions = new Map<string, number>();
  private readonly pendingUpdates: Array<{
    file: LeanWorkspaceFile;
    prevDoc: Text;
    changes: ChangeSet;
  }> = [];
  private readonly pendingLoads = new Map<string, Promise<LeanWorkspaceFile | null>>();

  constructor(
    client: LSPClient,
    private readonly options: LeanWorkspaceOptions = {},
  ) {
    super(client);
  }

  private resolveLanguageId(uri: string, fallback = "lean4"): string {
    return this.options.resolveLanguageId?.(uri) ?? (uri.endsWith(".lean") ? "lean4" : fallback);
  }

  private trackVersion(uri: string, version: number): number {
    this.fileVersions.set(uri, version);
    return version;
  }

  private nextFileVersion(uri: string): number {
    const next = (this.fileVersions.get(uri) ?? -1) + 1;
    this.fileVersions.set(uri, next);
    return next;
  }

  private addFile(file: LeanWorkspaceFile): LeanWorkspaceFile {
    const existing = this.getFile(file.uri);
    if (existing) {
      return existing as LeanWorkspaceFile;
    }
    this.files.push(file);
    this.trackVersion(file.uri, file.version);
    return file;
  }

  override getFile(uri: string): LeanWorkspaceFile | null {
    return (super.getFile(uri) as LeanWorkspaceFile | null) ?? null;
  }

  private async ensureLoadedFile(uri: string): Promise<LeanWorkspaceFile | null> {
    const existing = this.getFile(uri);
    if (existing) {
      return existing;
    }
    const pending = this.pendingLoads.get(uri);
    if (pending) {
      return pending;
    }
    const load = this.loadFile(uri);
    this.pendingLoads.set(uri, load);
    try {
      return await load;
    } finally {
      this.pendingLoads.delete(uri);
    }
  }

  private async loadFile(uri: string): Promise<LeanWorkspaceFile | null> {
    const loaded = await this.options.loadDocument?.(uri);
    if (!loaded) {
      return null;
    }
    const normalized = normalizeLoadedDocument(loaded);
    const version = normalized.version ?? this.nextFileVersion(uri);
    const file = new LeanWorkspaceFile(
      uri,
      normalized.languageId ?? this.resolveLanguageId(uri),
      this.trackVersion(uri, version),
      toText(normalized.doc),
    );
    return this.addFile(file);
  }

  override connected(): void {
    for (const file of this.files) {
      if (file.serverOpen || file.hasOpenView()) {
        this.client.didOpen(file);
      }
    }
  }

  override syncFiles() {
    const updates = this.pendingUpdates.splice(0, this.pendingUpdates.length);

    for (const file of this.files) {
      const view = file.getView();
      if (!view) {
        continue;
      }
      const plugin = LSPPlugin.get(view);
      if (!plugin || plugin.unsyncedChanges.empty) {
        continue;
      }
      updates.push({
        changes: plugin.unsyncedChanges,
        file,
        prevDoc: file.doc,
      });
      file.doc = view.state.doc;
      file.version = this.nextFileVersion(file.uri);
      plugin.clear();
    }

    return updates;
  }

  override async requestFile(uri: string): Promise<LeanWorkspaceFile | null> {
    return this.ensureLoadedFile(uri);
  }

  async openServerDocument(uri: string): Promise<LeanWorkspaceFile | null> {
    const file = await this.ensureLoadedFile(uri);
    if (!file || file.serverOpen) {
      return file;
    }
    file.serverOpen = true;
    this.client.didOpen(file);
    return file;
  }

  override openFile(uri: string, languageId: string, view: EditorView): void {
    let file = this.getFile(uri);
    const wasOpen = file?.hasOpenView() ?? false;

    if (!file) {
      file = this.addFile(
        new LeanWorkspaceFile(uri, languageId, this.nextFileVersion(uri), view.state.doc),
      );
    } else {
      file.languageId = languageId || file.languageId;
      file.doc = view.state.doc;
    }

    file.views.add(view);
    if (!wasOpen && !file.serverOpen) {
      this.client.didOpen(file);
    }
  }

  override closeFile(uri: string, view: EditorView): void {
    const file = this.getFile(uri);
    if (!file) {
      return;
    }
    file.views.delete(view);
    if (!file.hasOpenView() && !file.serverOpen) {
      this.client.didClose(uri);
    }
  }

  override updateFile(uri: string, update: TransactionSpec): void {
    const file = this.getFile(uri);
    if (!file) {
      return;
    }
    const view = file.getView();
    if (view) {
      view.dispatch(update);
      return;
    }
    const state = EditorState.create({ doc: file.doc });
    const transaction = state.update(update);
    const prevDoc = file.doc;
    file.doc = transaction.state.doc;
    file.version = this.nextFileVersion(uri);
    if (!transaction.changes.empty) {
      this.pendingUpdates.push({
        changes: transaction.changes,
        file,
        prevDoc,
      });
    }
    void Promise.resolve(this.options.onDocumentChange?.(uri, file, update)).catch((error) => {
      console.error(`[lean-workspace] Failed to apply document change for ${uri}`, error);
    });
  }

  override async displayFile(uri: string): Promise<EditorView | null> {
    const existing = await this.ensureLoadedFile(uri);
    const existingView = existing?.getView();
    if (existingView) {
      return existingView;
    }
    const opened = await this.options.displayDocument?.(uri, this);
    return opened ?? this.getFile(uri)?.getView() ?? null;
  }
}

export function createLeanWorkspace(options: LeanWorkspaceOptions = {}) {
  return (client: LSPClient): LeanWorkspace => new LeanWorkspace(client, options);
}
