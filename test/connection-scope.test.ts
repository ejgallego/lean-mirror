import { expect, test } from "vitest";
import { ConnectionScope } from "../demo/src/connectionScope.js";

test("overlapping opens share one acquisition and disposal obligation", async () => {
  const scope = new ConnectionScope<number>();
  let finish!: (n: number) => void;
  let acquisitions = 0, releases = 0;
  const acquire = async () => {
    acquisitions++;
    scope.own(() => { releases++; });
    return new Promise<number>(resolve => { finish = resolve; });
  };
  const first = scope.open(acquire), second = scope.open(acquire);
  expect(first).toBe(second);
  await Promise.resolve(); finish(42);
  expect(await first).toBe(42);
  expect(acquisitions).toBe(1);
  scope.dispose(); scope.dispose();
  expect(releases).toBe(1);
});

test("resources arriving after disposal are immediately released", async () => {
  const scope = new ConnectionScope<number>();
  let finish!: () => void;
  let releases = 0;
  const request = scope.open(async () => {
    await new Promise<void>(resolve => { finish = resolve; });
    scope.own(() => { releases++; });
    return 1;
  });
  const rejected = expect(request).rejects.toThrow("retired");
  await Promise.resolve(); scope.dispose(); finish();
  await rejected;
  expect(releases).toBe(1);
});
