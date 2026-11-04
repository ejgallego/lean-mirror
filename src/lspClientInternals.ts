/**
 * The only module that reads private `@codemirror/lsp-client` state.
 *
 * `WorkspaceMapping` is seeded with the files open when a request starts and
 * learns only about changes to files with an editor view. Lean requests load
 * target files later (references, rename, navigation) and edit cached files
 * without a view, so the workspace extends active mappings through these
 * internals. `@codemirror/lsp-client` is pinned for that reason; an upgrade must
 * keep `lspClientInternalsSupported()` true and pass the late-loaded-file and
 * in-flight-edit tests. Every accessor is guarded and degrades to a no-op when
 * the shape differs.
 */
import type { LSPClient, WorkspaceMapping } from "@codemirror/lsp-client";
import { ChangeSet, type Text } from "@codemirror/state";

interface ClientInternals {
  activeMappings?: readonly WorkspaceMapping[];
}

interface MappingInternals {
  mappings?: Map<string, unknown>;
  startDocs?: Map<string, Text>;
  addChanges?: (uri: string, changes: ChangeSet) => void;
}

function activeMappings(client: LSPClient): readonly WorkspaceMapping[] {
  const mappings = (client as unknown as ClientInternals).activeMappings;
  return Array.isArray(mappings) ? mappings : [];
}

function internalsOf(mapping: WorkspaceMapping): MappingInternals {
  return mapping as unknown as MappingInternals;
}

/**
 * Start tracking `uri` in mappings created before it was loaded, from `doc` as
 * loaded. Mappings that already track the URI are left unchanged.
 */
export function trackLateLoadedFile(client: LSPClient, uri: string, doc: Text): void {
  for (const mapping of activeMappings(client)) {
    const { mappings, startDocs } = internalsOf(mapping);
    if (!(mappings instanceof Map) || !(startDocs instanceof Map) || mappings.has(uri)) {
      continue;
    }
    mappings.set(uri, ChangeSet.empty(doc.length));
    startDocs.set(uri, doc);
  }
}

/** Record changes made to a document that has no editor view. */
export function recordClosedFileChanges(client: LSPClient, uri: string, changes: ChangeSet): void {
  for (const mapping of activeMappings(client)) {
    const { addChanges } = internalsOf(mapping);
    if (typeof addChanges === "function") {
      addChanges.call(mapping, uri, changes);
    }
  }
}

/** The document `uri` had when `mapping` started tracking it, if known. */
export function mappingStartDocument(mapping: WorkspaceMapping, uri: string): Text | null {
  const { startDocs } = internalsOf(mapping);
  return startDocs instanceof Map ? startDocs.get(uri) ?? null : null;
}

/** Whether the installed client still has every internal shape used here. */
export function lspClientInternalsSupported(client: LSPClient): boolean {
  const mapping = client.workspaceMapping();
  try {
    const { mappings, startDocs, addChanges } = internalsOf(mapping);
    return (
      activeMappings(client).includes(mapping) &&
      mappings instanceof Map &&
      startDocs instanceof Map &&
      typeof addChanges === "function"
    );
  } finally {
    mapping.destroy();
  }
}
