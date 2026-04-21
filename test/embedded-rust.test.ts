import { describe, expect, it } from "vitest";

import {
  parseEmbeddedRustBlocks,
  serializeEmbeddedRustBlock,
} from "../demo/src/embeddedRust.js";
import { parseCommentFencedBlocks, serializeCommentFencedBlock } from "../demo/src/embeddedBlocks.js";

describe("embeddedRust", () => {
  it("parses comment-delimited Rust blocks from a Lean document", () => {
    const source = [
      "#check Nat.succ",
      "",
      "-- ```rust demo",
      "-- fn add(a: i32, b: i32) -> i32 {",
      "--     a + b",
      "-- }",
      "-- ```",
      "",
    ].join("\n");

    const blocks = parseEmbeddedRustBlocks(source);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.key).toBe("rust:demo");
    expect(blocks[0]?.code).toContain("fn add");
  });

  it("serializes an updated Rust block back into Lean comment form", () => {
    const source = [
      "-- ```rust demo",
      "-- fn demo() {}",
      "-- ```",
      "",
    ].join("\n");

    const block = parseEmbeddedRustBlocks(source)[0];
    expect(block).toBeDefined();

    const serialized = serializeEmbeddedRustBlock(
      block!,
      'fn demo() {\n    println!("hi");\n}',
    );

    expect(serialized).toContain("-- ```rust demo");
    expect(serialized).toContain('--     println!("hi");');
    expect(serialized).toContain("-- ```");
  });

  it("generic comment-fenced block helpers work independently of Rust", () => {
    const source = [
      "-- ```demo card",
      "-- hello",
      "-- world",
      "-- ```",
      "",
    ].join("\n");

    const blocks = parseCommentFencedBlocks(source, {
      defaultTitle(block) {
        return block.label ?? `Demo ${block.ordinal}`;
      },
      kind: "demo",
    });

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.key).toBe("demo:card");

    const serialized = serializeCommentFencedBlock(blocks[0]!, "demo", "alpha\nbeta");
    expect(serialized).toContain("-- ```demo card");
    expect(serialized).toContain("-- alpha");
    expect(serialized).toContain("-- beta");
  });
});
