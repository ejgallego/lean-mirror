import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createZerocopyAnnealDemoEnv,
  zerocopyAnnealDescriptor,
  zerocopyAnnealExamples,
} from "../scripts/zerocopy-anneal-config.mjs";

describe("Zerocopy Anneal wrapper configuration", () => {
  it("owns prepared examples and external demo metadata", () => {
    const checkoutRoot = "/tmp/zerocopy-fixture";
    const env = createZerocopyAnnealDemoEnv(checkoutRoot, { CUSTOM_VALUE: "preserved" });

    expect(env.CUSTOM_VALUE).toBe("preserved");
    expect(env.LEAN_DEMO_ANNEAL_MANIFEST).toBe(join(checkoutRoot, "anneal", "Cargo.toml"));
    expect(env.LEAN_DEMO_RUST_ROOT).toBe(checkoutRoot);
    expect(env.LEAN_DEMO_TITLE).toBe(zerocopyAnnealDescriptor.title);
    expect(env.LEAN_DEMO_PROJECT).toBe(zerocopyAnnealDescriptor.project);
    expect(env.LEAN_DEMO_SUMMARY).toBe(zerocopyAnnealDescriptor.summary);
    expect(JSON.parse(env.LEAN_DEMO_EXAMPLE_PRESETS)).toEqual(zerocopyAnnealExamples);
    expect(zerocopyAnnealExamples.map((example) => example.id)).toEqual([
      "linked_list",
      "namespaces",
      "size_of_align_of",
      "abs",
    ]);
  });
});
