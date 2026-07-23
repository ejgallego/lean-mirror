import {
  LSPPlugin,
  Workspace,
  type WorkspaceFile,
  type WorkspaceMapping,
} from "@codemirror/lsp-client";
import { ChangeSet, EditorState, Text, type TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { LSPClient } from "@codemirror/lsp-client";

export interface LeanWorkspaceLoadResult {
  doc: string | Text;
  languageId?: string;
  version?: number;
}

export type LeanWorkspaceUnloadResult =
  | "in-use"
  | "not-loaded"
  | "unloaded";

export interface LeanServerDocumentLease {
  readonly file: LeanWorkspaceFile;
  readonly released: boolean;
  /**
   * Release this owner's reason for keeping the document open in Lean.
   *
   * Returns false when the lease had already been released.
   */
  release(): boolean;
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

/**
 * Add a newly loaded document to mappings that were created while an LSP
 * request was in flight.
 *
 * @codemirror/lsp-client 6.2 creates reference mappings before asynchronously
 * requesting response files, but only seeds them with files that were already
 * in the workspace. Its mapping registries are marked internal, so keep this
 * compatibility shim narrow and guarded.
 */
function addFileToActiveMappings(client: LSPClient, file: LeanWorkspaceFile): void {
  const activeMappings = (
    client as unknown as { activeMappings?: readonly WorkspaceMapping[] }
  ).activeMappings;
  if (!Array.isArray(activeMappings)) {
    return;
  }
  for (const mapping of activeMappings) {
    const internals = mapping as unknown as {
      mappings?: Map<string, unknown>;
      startDocs?: Map<string, Text>;
    };
    if (
      !(internals.mappings instanceof Map) ||
      !(internals.startDocs instanceof Map) ||
      internals.mappings.has(file.uri)
    ) {
      continue;
    }
    internals.mappings.set(file.uri, ChangeSet.empty(file.doc.length));
    internals.startDocs.set(file.uri, file.doc);
  }
}

function addClosedFileChangesToActiveMappings(
  client: LSPClient,
  uri: string,
  changes: ChangeSet,
): void {
  const activeMappings = (
    client as unknown as { activeMappings?: readonly WorkspaceMapping[] }
  ).activeMappings;
  if (!Array.isArray(activeMappings)) {
    return;
  }
  for (const mapping of activeMappings) {
    const addChanges = (
      mapping as unknown as {
        addChanges?: (changedUri: string, changes: ChangeSet) => void;
      }
    ).addChanges;
    addChanges?.call(mapping, uri, changes);
  }
}

export class LeanWorkspaceFile implements WorkspaceFile {
  view: EditorView | null = null;

  constructor(
    readonly uri: string,
    public languageId: string,
    public version: number,
    public doc: Text,
  ) {}

  getView(main?: EditorView): EditorView | null {
    if (main && this.view !== main) {
      return null;
    }
    return this.view;
  }

  hasOpenView(): boolean {
    return this.view !== null;
  }

  /** Whether one or more non-editor owners keep this document open in Lean. */
  get serverOpen(): boolean {
    return (serverDocumentOwners.get(this)?.size ?? 0) > 0;
  }
}

const serverDocumentOwners = new WeakMap<LeanWorkspaceFile, Set<object>>();

function ownersFor(file: LeanWorkspaceFile): Set<object> {
  let owners = serverDocumentOwners.get(file);
  if (!owners) {
    owners = new Set();
    serverDocumentOwners.set(file, owners);
  }
  return owners;
}

class LeanServerDocumentLeaseImpl implements LeanServerDocumentLease {
  released = false;

  constructor(
    readonly file: LeanWorkspaceFile,
    private releaseLease: ((owner: object) => void) | null,
  ) {}

  release(): boolean {
    const releaseLease = this.releaseLease;
    if (!releaseLease) {
      return false;
    }
    this.released = true;
    this.releaseLease = null;
    releaseLease(this);
    return true;
  }
}

export class LeanWorkspace extends Workspace {
  /** Loaded documents, including cached files that are not currently open in Lean. */
  readonly files: LeanWorkspaceFile[] = [];
  private connectionActive = false;
  private readonly fileVersions = new Map<string, number>();
  private readonly pendingDocumentChanges = new Map<string, Set<Promise<void>>>();
  private readonly pendingUpdates = new Map<string, {
    file: LeanWorkspaceFile;
    prevDoc: Text;
    changes: ChangeSet;
  }>();
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
    addFileToActiveMappings(this.client, file);
    return file;
  }

  override getFile(uri: string): LeanWorkspaceFile | null {
    return (super.getFile(uri) as LeanWorkspaceFile | null) ?? null;
  }

  private isOpen(file: LeanWorkspaceFile): boolean {
    return file.hasOpenView() || file.serverOpen;
  }

  private absorbUnsynchronizedChanges(): void {
    const changedFiles = new Set<LeanWorkspaceFile>();
    for (const pending of this.pendingUpdates.values()) {
      changedFiles.add(pending.file);
    }
    this.pendingUpdates.clear();

    for (const file of this.files) {
      const view = file.getView();
      if (!view) {
        continue;
      }
      const plugin = LSPPlugin.get(view);
      if (plugin && !plugin.unsyncedChanges.empty) {
        file.doc = view.state.doc;
        plugin.clear();
        changedFiles.add(file);
      }
    }
    for (const file of changedFiles) {
      file.version = this.nextFileVersion(file.uri);
    }
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
    this.connectionActive = true;
    for (const file of this.files) {
      if (this.isOpen(file)) {
        this.pendingUpdates.delete(file.uri);
        this.client.didOpen(file);
      }
    }
  }

  override disconnected(): void {
    this.connectionActive = false;
    this.absorbUnsynchronizedChanges();
  }

  override syncFiles() {
    if (!this.connectionActive) {
      this.absorbUnsynchronizedChanges();
      return [];
    }
    const updates = new Map(this.pendingUpdates);
    this.pendingUpdates.clear();

    for (const [uri, pending] of updates) {
      if (!this.isOpen(pending.file)) {
        updates.delete(uri);
      }
    }

    for (const file of this.files) {
      const view = file.getView();
      if (!view) {
        continue;
      }
      const plugin = LSPPlugin.get(view);
      if (!plugin || plugin.unsyncedChanges.empty) {
        continue;
      }
      const pending = updates.get(file.uri);
      if (pending) {
        pending.changes = pending.changes.compose(plugin.unsyncedChanges);
      } else {
        updates.set(file.uri, {
          changes: plugin.unsyncedChanges,
          file,
          prevDoc: file.doc,
        });
      }
      file.doc = view.state.doc;
      plugin.clear();
    }

    for (const update of updates.values()) {
      update.file.version = this.nextFileVersion(update.file.uri);
    }
    return [...updates.values()];
  }

  override async requestFile(uri: string): Promise<LeanWorkspaceFile | null> {
    return this.ensureLoadedFile(uri);
  }

  /**
   * Acquire independent ownership that keeps a loaded document open in Lean.
   *
   * The caller must release the returned lease when it no longer needs the
   * server to process this document.
   */
  async acquireServerDocument(uri: string): Promise<LeanServerDocumentLease | null> {
    const file = await this.ensureLoadedFile(uri);
    if (!file) {
      return null;
    }
    const wasOpen = this.isOpen(file);
    const lease = new LeanServerDocumentLeaseImpl(
      file,
      (owner) => this.releaseServerDocument(file, owner),
    );
    ownersFor(file).add(lease);
    if (!wasOpen) {
      this.pendingUpdates.delete(uri);
      if (this.connectionActive) {
        this.client.didOpen(file);
      }
    }
    return lease;
  }

  private releaseServerDocument(file: LeanWorkspaceFile, owner: object): void {
    const owners = ownersFor(file);
    if (!owners.has(owner)) {
      return;
    }
    const willClose = owners.size === 1 && !file.hasOpenView();
    if (willClose && this.connectionActive) {
      this.client.sync();
    }
    owners.delete(owner);
    if (willClose && this.connectionActive) {
      this.client.didClose(file.uri);
    }
  }

  /**
   * Remove an unowned document from the workspace cache.
   *
   * In-flight loading and host change callbacks finish before an otherwise
   * unloadable document is removed.
   */
  async unloadDocument(uri: string): Promise<LeanWorkspaceUnloadResult> {
    await this.pendingLoads.get(uri);
    const file = this.getFile(uri);
    if (!file) {
      return "not-loaded";
    }
    if (this.isOpen(file)) {
      return "in-use";
    }
    while (this.pendingDocumentChanges.get(uri)?.size) {
      await Promise.all(this.pendingDocumentChanges.get(uri)!);
    }
    if (this.getFile(uri) !== file) {
      return "not-loaded";
    }
    if (this.isOpen(file)) {
      return "in-use";
    }
    this.pendingUpdates.delete(uri);
    const index = this.files.indexOf(file);
    if (index >= 0) {
      this.files.splice(index, 1);
    }
    return "unloaded";
  }

  override openFile(uri: string, languageId: string, view: EditorView): void {
    let file = this.getFile(uri);
    const wasOpen = file ? this.isOpen(file) : false;

    if (!file) {
      file = this.addFile(
        new LeanWorkspaceFile(uri, languageId, this.nextFileVersion(uri), view.state.doc),
      );
    } else {
      if (file.view === view) {
        return;
      }
      if (file.view && file.view !== view) {
        throw new Error(`LeanWorkspace does not support multiple editor views for ${uri}.`);
      }
      if (!file.doc.eq(view.state.doc)) {
        throw new Error(
          `Cannot open ${uri} with content that differs from the workspace document.`,
        );
      }
      file.languageId = languageId || file.languageId;
    }

    file.view = view;
    if (!wasOpen) {
      this.pendingUpdates.delete(uri);
      if (this.connectionActive) {
        this.client.didOpen(file);
      }
    }
  }

  override closeFile(uri: string, view: EditorView): void {
    const file = this.getFile(uri);
    if (!file) {
      return;
    }
    if (file.view !== view) {
      return;
    }
    const willClose = !file.serverOpen;
    if (this.connectionActive) {
      this.client.sync();
    } else {
      const plugin = LSPPlugin.get(view);
      if (plugin && !plugin.unsyncedChanges.empty) {
        file.doc = view.state.doc;
        file.version = this.nextFileVersion(uri);
        plugin.clear();
      }
    }
    file.view = null;
    if (willClose && this.connectionActive) {
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
    if (transaction.changes.empty) {
      return;
    }
    const prevDoc = file.doc;
    file.doc = transaction.state.doc;
    if (this.isOpen(file)) {
      const pending = this.pendingUpdates.get(uri);
      if (pending) {
        pending.changes = pending.changes.compose(transaction.changes);
      } else {
        this.pendingUpdates.set(uri, {
          changes: transaction.changes,
          file,
          prevDoc,
        });
      }
    } else {
      addClosedFileChangesToActiveMappings(this.client, uri, transaction.changes);
      file.version = this.nextFileVersion(uri);
    }
    const onDocumentChange = this.options.onDocumentChange;
    if (onDocumentChange) {
      let result: Promise<void> | void;
      try {
        result = onDocumentChange(uri, file, update);
      } catch (error) {
        console.error(`[lean-workspace] Failed to apply document change for ${uri}`, error);
        return;
      }
      const changes = this.pendingDocumentChanges.get(uri) ?? new Set<Promise<void>>();
      this.pendingDocumentChanges.set(uri, changes);
      let pending!: Promise<void>;
      pending = Promise.resolve(result)
        .catch((error: unknown) => {
          console.error(`[lean-workspace] Failed to apply document change for ${uri}`, error);
        })
        .finally(() => {
          changes.delete(pending);
          if (changes.size === 0) {
            this.pendingDocumentChanges.delete(uri);
          }
        });
      changes.add(pending);
    }
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
