import { EditorState, Text } from "@codemirror/state";
import { history, undoDepth } from "@codemirror/commands";
import { afterEach, expect, test, vi } from "vitest";
import { DemoDocuments, type AuthoredSnapshot } from "../demo/src/demoDocuments.js";
import { SourcePersistence } from "../demo/src/sourcePersistence.js";

afterEach(() => vi.useRealTimers());
const snapshot = (revision: number, text: string): AuthoredSnapshot => ({uri:"file:///Main.rs",revision,text});

test("live contents take precedence over a retained prior visit", () => {
  let active: { uri: string; state: EditorState } | null = null;
  const documents = new DemoDocuments(() => active);
  const first = EditorState.create({doc:"first", extensions:[history()]});
  documents.remember("rust", first);
  const edited = first.update({changes:{from:0,to:5,insert:"edited"}}).state;
  active = {uri:"rust",state:edited};
  expect(documents.snapshot("rust")?.text).toBe("edited");
  documents.remember("rust",edited,true);
  documents.retainActive(); active = null;
  expect(documents.state("rust")).toBe(edited);
  expect(undoDepth(documents.state("rust")!)).toBeGreaterThan(0);
});

test("authored revisions distinguish ABA edits from unchanged presentation state", () => {
  const documents = new DemoDocuments(() => null);
  const first = EditorState.create({doc:"A"});
  documents.remember("rust", first);
  const saved = documents.snapshot("rust")!;
  const other = first.update({changes:{from:0,to:1,insert:"B"}}).state;
  documents.remember("rust",other,true);
  documents.remember("rust",first,true);
  expect(documents.snapshot("rust")?.text).toBe(saved.text);
  expect(documents.isCurrent(saved)).toBe(false);
  const current = documents.snapshot("rust")!;
  documents.remember("rust",first.update({selection:{anchor:1}}).state);
  expect(documents.isCurrent(current)).toBe(true);
});

test("hidden workspace updates replace retained text and invalidate snapshots", () => {
  const documents = new DemoDocuments(() => null);
  documents.remember("lean", EditorState.create({doc:"old"}));
  const old = documents.snapshot("lean")!;
  documents.applyWorkspaceUpdate("lean", Text.of(["new"]), {changes:{from:0,to:3,insert:"new"}});
  expect(documents.snapshot("lean")?.text).toBe("new");
  expect(documents.isCurrent(old)).toBe(false);
});

test("a late receipt advances the disk revision while preserving a newer restored snapshot", async () => {
  vi.useFakeTimers();
  let current = snapshot(1,"edited");
  let finish!: (receipt: {diskRevision:string;revision:number}) => void;
  const expected: string[] = [];
  const persistence = new SourcePersistence({initialDiskRevision:"disk-0",
    currentSnapshot:()=>current, isCurrent:s=>s.revision===current.revision,
    save:async (_source, diskRevision, revision) => {
      expected.push(diskRevision);
      return expected.length===1 ? new Promise<{diskRevision:string;revision:number}>(resolve=>{finish=resolve;})
        : {diskRevision:"disk-2",revision};
    }});
  const first = persistence.schedule(current);
  await vi.advanceTimersByTimeAsync(450);
  current = snapshot(2,"original");
  const second = persistence.schedule(current);
  await vi.advanceTimersByTimeAsync(450);
  finish({diskRevision:"disk-1",revision:1});
  expect((await first)?.snapshot).toEqual(snapshot(1,"edited"));
  expect((await second)?.snapshot).toEqual(current);
  expect(expected).toEqual(["disk-0","disk-1"]);
  persistence.dispose();
});

test("generation failure cannot poison a committed source receipt", async () => {
  vi.useFakeTimers();
  let current = snapshot(1,"invalid");
  const revisions: string[] = [];
  const persistence = new SourcePersistence({initialDiskRevision:"disk-0",currentSnapshot:()=>current,
    isCurrent:s=>s.revision===current.revision,
    save:async (_source, expected, revision) => { revisions.push(expected); return {diskRevision:`disk-${revision}`,revision}; }});
  await expect(persistence.withSavedSnapshot(async saved => {
    expect(saved.receipt.diskRevision).toBe("disk-1");
    throw new Error("generator failed");
  })).rejects.toThrow("generator failed");
  current = snapshot(2,"corrected");
  const corrected = persistence.schedule(current);
  await vi.advanceTimersByTimeAsync(450); await corrected;
  expect(revisions).toEqual(["disk-0","disk-1"]);
  persistence.dispose();
});

test("canceling debounced work and disposal settle callers without starting new saves", async () => {
  vi.useFakeTimers();
  const current = snapshot(1,"source");
  const save = vi.fn(async () => ({diskRevision:"new",revision:1}));
  const persistence = new SourcePersistence({initialDiskRevision:"old",currentSnapshot:()=>current,isCurrent:()=>true,save});
  const canceled = persistence.schedule(current);
  persistence.cancelScheduled(); expect(await canceled).toBeNull();
  const retired = persistence.schedule(current);
  persistence.dispose(); expect(await retired).toBeNull();
  await vi.runAllTimersAsync(); expect(save).not.toHaveBeenCalled();
});
