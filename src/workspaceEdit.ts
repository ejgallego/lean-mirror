import {
  LSPPlugin,
  type LSPClient,
  type WorkspaceFile,
  type WorkspaceMapping,
} from "@codemirror/lsp-client";
import {
  EditorState,
  type ChangeSpec,
  type Text,
  type TransactionSpec,
} from "@codemirror/state";
import type {
  Position,
  TextDocumentEdit,
  TextEdit,
  WorkspaceEdit,
} from "vscode-languageserver-protocol";
import { captureClientOperation } from "./clientLifetime.js";
import { mappingStartDocument } from "./lspClientInternals.js";

export interface LeanWorkspaceEditOptions {
  /**
   * Mapping created immediately before the request that produced this edit.
   * It preserves correct positions when local changes occur while the request
   * is in flight.
   */
  mapping?: WorkspaceMapping;
  /** Synchronize LSP-open documents after applying the edit. Defaults to true. */
  sync?: boolean;
  /** CodeMirror user event attached to each transaction. */
  userEvent?: string;
  /** Cancel host work, including asynchronous target loading. */
  signal?: AbortSignal;
}

export interface LeanWorkspaceEditResult {
  applied: boolean;
  changedUris: readonly string[];
  failureReason?: string;
  failedChange?: number;
}

interface EditGroup {
  readonly uri: string;
  readonly edits: readonly TextEdit[];
  readonly version: number | null | undefined;
  readonly index: number;
}

interface PreparedGroup {
  readonly uri: string;
  readonly changes: readonly ChangeSpec[];
  readonly index: number;
}

interface PositionedChange {
  readonly from: number;
  readonly to: number;
  readonly insert: string;
  readonly sourceIndex: number;
}

function failed(failureReason: string, failedChange?: number): LeanWorkspaceEditResult {
  return failedChange === undefined
    ? { applied: false, changedUris: [], failureReason }
    : { applied: false, changedUris: [], failureReason, failedChange };
}

function isTextDocumentEdit(
  change: NonNullable<WorkspaceEdit["documentChanges"]>[number],
): change is TextDocumentEdit {
  return "textDocument" in change && "edits" in change;
}

function collectEditGroups(edit: WorkspaceEdit): EditGroup[] | LeanWorkspaceEditResult {
  const groups: EditGroup[] = [];
  if (edit.documentChanges !== undefined) {
    const seen = new Set<string>();
    for (const [index, change] of edit.documentChanges.entries()) {
      if (!isTextDocumentEdit(change)) {
        return failed(
          `Unsupported workspace resource operation: ${change.kind}.`,
          index,
        );
      }
      const uri = change.textDocument.uri;
      if (seen.has(uri)) {
        return failed(
          `Multiple ordered document changes for ${uri} are not supported.`,
          index,
        );
      }
      seen.add(uri);
      groups.push({
        uri,
        edits: change.edits,
        version: change.textDocument.version,
        index,
      });
    }
    return groups;
  }

  for (const [index, [uri, edits]] of Object.entries(edit.changes ?? {}).entries()) {
    groups.push({ uri, edits, version: undefined, index });
  }
  return groups;
}

/**
 * Validate a position against `doc`. Following the LSP specification, a
 * character past the end of its line is clamped to the line end. Positions on
 * a line past the end of the document are rejected rather than clamped, since
 * that usually means the edit targets different text.
 */
function clampPosition(doc: Text, position: Position): Position | null {
  if (
    !Number.isInteger(position.line) ||
    !Number.isInteger(position.character) ||
    position.line < 0 ||
    position.character < 0 ||
    position.line >= doc.lines
  ) {
    return null;
  }
  const lineLength = doc.line(position.line + 1).length;
  return position.character > lineLength
    ? { line: position.line, character: lineLength }
    : position;
}

function positionToOffset(doc: Text, position: Position): number | null {
  const clamped = clampPosition(doc, position);
  return clamped ? doc.line(clamped.line + 1).from + clamped.character : null;
}

function mappedPosition(
  mapping: WorkspaceMapping | undefined,
  file: WorkspaceFile,
  currentDoc: Text,
  position: Position,
  assoc: number,
): number | null {
  if (mapping?.getMapping(file.uri)) {
    const startDoc = mappingStartDocument(mapping, file.uri);
    const start = startDoc ? clampPosition(startDoc, position) : position;
    if (!start) {
      return null;
    }
    try {
      const offset = mapping.mapPosition(file.uri, start, assoc);
      return Number.isInteger(offset) && offset >= 0 && offset <= currentDoc.length
        ? offset
        : null;
    } catch {
      return null;
    }
  }

  const view = file.getView();
  if (view) {
    const plugin = LSPPlugin.get(view);
    if ((plugin && !plugin.unsyncedChanges.empty) || !file.doc.eq(currentDoc)) {
      return null;
    }
  }
  return positionToOffset(file.doc, position);
}

function prepareChanges(
  group: EditGroup,
  file: WorkspaceFile,
  mapping: WorkspaceMapping | undefined,
): PreparedGroup | LeanWorkspaceEditResult {
  if (group.version !== null && group.version !== undefined && group.version !== file.version) {
    return failed(
      `Workspace edit for ${group.uri} targets version ${group.version}, but the workspace is at version ${file.version}.`,
      group.index,
    );
  }

  const currentDoc = file.getView()?.state.doc ?? file.doc;
  const positioned: PositionedChange[] = [];
  for (const [sourceIndex, edit] of group.edits.entries()) {
    // Check the server's own ordering before clamping can collapse a reversed range.
    const { start, end } = edit.range;
    const reversed = start.line > end.line || (start.line === end.line && start.character > end.character);
    const from = reversed ? null : mappedPosition(mapping, file, currentDoc, start, 1);
    const to = reversed ? null : mappedPosition(mapping, file, currentDoc, end, -1);
    if (from === null || to === null || from > to) {
      return failed(
        `Workspace edit for ${group.uri} contains an invalid or stale range.`,
        group.index,
      );
    }
    positioned.push({ from, to, insert: edit.newText, sourceIndex });
  }

  positioned.sort(
    (left, right) =>
      left.from - right.from ||
      left.to - right.to ||
      left.sourceIndex - right.sourceIndex,
  );
  let previousEnd = 0;
  for (const [index, change] of positioned.entries()) {
    if (index > 0 && change.from < previousEnd) {
      return failed(
        `Workspace edit for ${group.uri} contains overlapping ranges.`,
        group.index,
      );
    }
    previousEnd = Math.max(previousEnd, change.to);
  }

  const changes = positioned.map(({ from, to, insert }) => ({ from, to, insert }));
  try {
    EditorState.create({ doc: currentDoc }).update({ changes });
  } catch {
    return failed(
      `Workspace edit for ${group.uri} could not be represented as a CodeMirror transaction.`,
      group.index,
    );
  }
  return { uri: group.uri, changes, index: group.index };
}

/**
 * Apply an LSP workspace edit through the client's host workspace.
 *
 * All target documents are loaded and every range is validated before any
 * transaction is dispatched. Text edits in both `changes` and versioned
 * `documentChanges` are supported. Resource operations are rejected without
 * partially applying the edit because their filesystem policy belongs to the
 * host application.
 */
export async function applyLeanWorkspaceEdit(
  client: LSPClient,
  edit: WorkspaceEdit,
  options: LeanWorkspaceEditOptions = {},
): Promise<LeanWorkspaceEditResult> {
  const current = captureClientOperation(client);
  const cancelled = () => !current() || options.signal?.aborted;
  if (cancelled()) return failed("Workspace edit was cancelled or its client disconnected.");
  const collected = collectEditGroups(edit);
  if (!Array.isArray(collected)) {
    return collected;
  }

  const files = new Map<string, WorkspaceFile>();
  const uniqueUris = [...new Set(collected.map((group) => group.uri))];
  const loaded = await Promise.all(
    uniqueUris.map(async (uri) => {
      try {
        return { uri, file: await client.workspace.requestFile(uri) };
      } catch (error) {
        return {
          uri,
          file: null,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
  if (cancelled()) return failed("Workspace edit was cancelled or its client disconnected.");
  for (const result of loaded) {
    if (!result.file) {
      const group = collected.find((candidate) => candidate.uri === result.uri);
      const detail = "error" in result ? `: ${result.error}` : "";
      return failed(
        `Workspace document ${result.uri} could not be loaded${detail}.`,
        group?.index,
      );
    }
    files.set(result.uri, result.file);
  }

  const prepared: PreparedGroup[] = [];
  for (const group of collected) {
    const file = files.get(group.uri);
    if (!file || client.workspace.getFile(group.uri) !== file) {
      return failed(`Workspace document ${group.uri} is unavailable.`, group.index);
    }
    const result = prepareChanges(group, file, options.mapping);
    if ("applied" in result) {
      return result;
    }
    prepared.push(result);
  }

  const changedUris: string[] = [];
  for (const group of prepared) {
    if (cancelled()) {
      return { applied: false, changedUris, failureReason: "Workspace edit was cancelled or its client disconnected." };
    }
    if (group.changes.length === 0) {
      continue;
    }
    const update: TransactionSpec = {
      changes: group.changes,
      ...(options.userEvent === undefined ? {} : { userEvent: options.userEvent }),
    };
    client.workspace.updateFile(group.uri, update);
    changedUris.push(group.uri);
  }
  if (options.sync !== false && changedUris.length > 0) {
    client.sync();
    await Promise.resolve();
  }
  return { applied: true, changedUris };
}
