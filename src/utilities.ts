import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import {
  foldGutter,
  foldKeymap,
} from "@codemirror/language";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import type { Extension } from "@codemirror/state";
import {
  EditorView,
  type KeyBinding,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";

export interface LeanUtilityOptions {
  lineNumbers?: boolean;
  activeLine?: boolean;
  drawSelection?: boolean;
  history?: boolean;
  search?: boolean;
  foldGutter?: boolean;
  lineWrapping?: boolean;
  indentWithTab?: boolean;
  defaultKeymap?: boolean;
  historyKeymap?: boolean;
  searchKeymap?: boolean;
  foldKeymap?: boolean;
}

export function leanUtilities(options: LeanUtilityOptions = {}): Extension[] {
  const extensions: Extension[] = [];
  const bindings: KeyBinding[] = [];

  if (options.lineNumbers !== false) {
    extensions.push(lineNumbers());
  }
  if (options.activeLine !== false) {
    extensions.push(highlightActiveLine(), highlightActiveLineGutter());
  }
  if (options.drawSelection !== false) {
    extensions.push(drawSelection());
  }
  if (options.history !== false) {
    extensions.push(history());
  }
  if (options.search !== false) {
    extensions.push(highlightSelectionMatches());
  }
  if (options.foldGutter !== false) {
    extensions.push(foldGutter());
  }
  if (options.lineWrapping) {
    extensions.push(EditorView.lineWrapping);
  }
  if (options.defaultKeymap !== false) {
    bindings.push(...defaultKeymap);
  }
  if (options.historyKeymap !== false) {
    bindings.push(...historyKeymap);
  }
  if (options.searchKeymap !== false) {
    bindings.push(...searchKeymap);
  }
  if (options.foldKeymap !== false) {
    bindings.push(...foldKeymap);
  }
  if (options.indentWithTab !== false) {
    bindings.push(indentWithTab);
  }
  if (bindings.length > 0) {
    extensions.push(keymap.of(bindings));
  }

  return extensions;
}
