import { describe, expect, it } from "vitest";

import { readNpmPackEntry } from "../scripts/npm-pack.mjs";

const packageName = "codemirror-lean4-lsp";
const entry = {
  name: packageName,
  filename: `${packageName}-0.1.0.tgz`,
  files: [{ path: "dist/index.js" }],
};

describe("npm pack metadata", () => {
  it.each([
    ["npm 11", [entry]],
    ["npm 12", { [packageName]: entry }],
  ])("reads %s output", (_version, output) => {
    expect(readNpmPackEntry(JSON.stringify(output), packageName)).toEqual(entry);
  });

  it.each([
    null,
    [],
    [entry, entry],
    { other: entry },
    [{ ...entry, name: "other" }],
    { [packageName]: { ...entry, name: "other" } },
    [{ ...entry, filename: null }],
    [{ ...entry, files: [{ size: 10 }] }],
  ].map((output) => [output]))("rejects missing, ambiguous, or malformed package metadata: %j", (output) => {
    expect(() => readNpmPackEntry(JSON.stringify(output), packageName)).toThrow(/file metadata/);
  });
});
