import { EditorState, type Text, type TransactionSpec } from "@codemirror/state";

export interface AuthoredSnapshot {
  readonly uri: string;
  readonly revision: number;
  readonly text: string;
}

/** Retained editor state preserves undo; the active view supplies live contents. */
export class DemoDocuments {
  private readonly states = new Map<string, EditorState>();
  private readonly revisions = new Map<string, number>();
  constructor(private readonly active: () => { uri: string; state: EditorState } | null) {}

  state(uri: string): EditorState | undefined {
    const active = this.active();
    return active?.uri === uri ? active.state : this.states.get(uri);
  }
  remember(uri: string, state: EditorState, authoredChange = false): void {
    this.states.set(uri, state);
    this.revisions.set(uri, (this.revisions.get(uri) ?? 0) + (authoredChange ? 1 : 0));
  }
  retainActive(): void {
    const active = this.active();
    if (active) this.remember(active.uri, active.state);
  }
  snapshot(uri: string): AuthoredSnapshot | null {
    const state = this.state(uri);
    return state ? Object.freeze({ uri, revision: this.revisions.get(uri) ?? 0, text: state.doc.toString() }) : null;
  }
  isCurrent(snapshot: AuthoredSnapshot): boolean {
    const current = this.snapshot(snapshot.uri);
    return !!current && current.revision === snapshot.revision && current.text === snapshot.text;
  }
  applyWorkspaceUpdate(uri: string, document: Text, update: TransactionSpec): void {
    if (this.active()?.uri === uri) return; // The active view observes its own transactions.
    const state = this.states.get(uri);
    if (!state) return;
    const transaction = state.update(update);
    const next = transaction.state.doc.eq(document) ? transaction.state
      : state.update({ changes: { from: 0, to: state.doc.length, insert: document } }).state;
    this.remember(uri, next, transaction.docChanged || !state.doc.eq(next.doc));
  }
  clear(): void { this.states.clear(); this.revisions.clear(); }
}
