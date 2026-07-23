import { LSPPlugin } from "@codemirror/lsp-client";
import type {
  Command,
  EditorView,
  KeyBinding,
} from "@codemirror/view";
import type {
  Location,
  LocationLink,
  ServerCapabilities,
  TextDocumentPositionParams,
} from "vscode-languageserver-protocol";

type NavigationLocation = Location | LocationLink;

interface NavigationTarget {
  readonly uri: string;
  readonly start: { readonly line: number; readonly character: number };
}

interface NavigationRequest {
  readonly method:
    | "textDocument/declaration"
    | "textDocument/definition"
    | "textDocument/implementation"
    | "textDocument/typeDefinition";
  readonly capability: keyof ServerCapabilities;
  readonly errorMessage: string;
}

function targetOf(location: NavigationLocation): NavigationTarget {
  return "targetUri" in location
    ? {
        uri: location.targetUri,
        start: location.targetSelectionRange.start,
      }
    : {
        uri: location.uri,
        start: location.range.start,
      };
}

function navigate(view: EditorView, request: NavigationRequest): boolean {
  const plugin = LSPPlugin.get(view);
  if (
    !plugin ||
    plugin.client.serverCapabilities?.[request.capability] === false
  ) {
    return false;
  }

  plugin.client.sync();
  void plugin.client.withMapping(async (mapping) => {
    const response = await plugin.client.request<
      TextDocumentPositionParams,
      NavigationLocation | NavigationLocation[] | null
    >(request.method, {
      textDocument: { uri: plugin.uri },
      position: plugin.toPosition(view.state.selection.main.head),
    });
    const location = Array.isArray(response) ? response[0] : response;
    if (!location) {
      return;
    }

    const target = targetOf(location);
    const targetView = target.uri === plugin.uri
      ? view
      : await plugin.client.workspace.displayFile(target.uri);
    if (!targetView) {
      return;
    }
    const position = mapping.getMapping(target.uri)
      ? mapping.mapPosition(target.uri, target.start)
      : plugin.fromPosition(target.start, targetView.state.doc);
    targetView.dispatch({
      selection: { anchor: position },
      scrollIntoView: true,
      userEvent: "select.definition",
    });
  }).catch((error: unknown) => {
    plugin.reportError(request.errorMessage, error);
  });
  return true;
}

/** Jump to a Lean definition returned as either an LSP Location or LocationLink. */
export const leanJumpToDefinition: Command = (view) =>
  navigate(view, {
    method: "textDocument/definition",
    capability: "definitionProvider",
    errorMessage: "Find definition failed",
  });

/** Jump to a Lean declaration returned as either an LSP Location or LocationLink. */
export const leanJumpToDeclaration: Command = (view) =>
  navigate(view, {
    method: "textDocument/declaration",
    capability: "declarationProvider",
    errorMessage: "Find declaration failed",
  });

/** Jump to a Lean type definition returned as either an LSP Location or LocationLink. */
export const leanJumpToTypeDefinition: Command = (view) =>
  navigate(view, {
    method: "textDocument/typeDefinition",
    capability: "typeDefinitionProvider",
    errorMessage: "Find type definition failed",
  });

/** Jump to an implementation returned as either an LSP Location or LocationLink. */
export const leanJumpToImplementation: Command = (view) =>
  navigate(view, {
    method: "textDocument/implementation",
    capability: "implementationProvider",
    errorMessage: "Find implementation failed",
  });

/** Binds F12 to LocationLink-aware Lean definition navigation. */
export const leanJumpToDefinitionKeymap: readonly KeyBinding[] = [
  { key: "F12", run: leanJumpToDefinition, preventDefault: true },
];
