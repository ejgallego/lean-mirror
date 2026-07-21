import { describe, expect, it } from "vitest";

import { DiagnosticGenerationGate } from "../demo/src/diagnosticGeneration.js";

describe("diagnostic generation gate", () => {
  it("accepts only the current synchronized document version", () => {
    const gate = new DiagnosticGenerationGate();
    const initial = gate.recordSync(0);

    expect(gate.isCurrent(initial)).toBe(true);
    expect(gate.acceptsPush(0)).toBe(true);
    expect(gate.acceptsPush(1)).toBe(false);

    gate.beginEdit();
    expect(gate.isCurrent(initial)).toBe(false);
    expect(gate.acceptsPush(0)).toBe(false);

    const edited = gate.recordSync(1);
    expect(gate.isCurrent(edited)).toBe(true);
    expect(gate.acceptsPush(0)).toBe(false);
    expect(gate.acceptsPush(1)).toBe(true);
  });

  it("accepts unversioned pushes only for the initial document generation", () => {
    const gate = new DiagnosticGenerationGate();
    const first = gate.recordSync();
    expect(gate.acceptsPush()).toBe(true);
    gate.beginEdit();
    const second = gate.recordSync();

    expect(gate.isCurrent(first)).toBe(false);
    expect(gate.isCurrent(second)).toBe(true);
    expect(gate.acceptsPush()).toBe(false);
  });
});
