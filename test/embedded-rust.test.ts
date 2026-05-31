import { describe, expect, it } from "vitest";

import {
  buildEmbeddedLeanDocument,
  mapEmbeddedLeanDiagnostics,
  parseEmbeddedLeanBlocks,
  serializeEmbeddedLeanBlock,
} from "../demo/src/embeddedLean.js";
import {
  parseEmbeddedRustBlocks,
  serializeEmbeddedRustBlock,
} from "../demo/src/embeddedRust.js";
import {
  createVersoCommentAdapter,
  parseVersoCommentBlocks,
  serializeVersoCommentBlock,
  type EmbeddedBlock,
} from "../demo/src/embeddedBlocks.js";

describe("embeddedRust", () => {
  it("parses verso-comment Rust blocks from a Lean document", () => {
    const source = [
      "#check Nat.succ",
      "",
      "/-!",
      "```rust demo",
      "fn add(a: i32, b: i32) -> i32 {",
      "    a + b",
      "}",
      "```",
      "-/",
      "",
    ].join("\n");

    const blocks = parseEmbeddedRustBlocks(source);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.key).toBe("rust:demo");
    expect(blocks[0]?.code).toContain("fn add");
  });

  it("serializes an updated Rust block back into a Lean verso comment", () => {
    const source = [
      "/-!",
      "```rust demo",
      "fn demo() {}",
      "```",
      "-/",
      "",
    ].join("\n");

    const block = parseEmbeddedRustBlocks(source)[0];
    expect(block).toBeDefined();

    const serialized = serializeEmbeddedRustBlock(
      block!,
      'fn demo() {\n    println!("hi");\n}',
    );

    expect(serialized).toContain("/-!");
    expect(serialized).toContain("```rust demo");
    expect(serialized).toContain('    println!("hi");');
    expect(serialized).toContain("```");
    expect(serialized).toContain("-/");
  });

  it("generic verso-comment block helpers work independently of Rust", () => {
    const source = [
      "/-!",
      "```demo card",
      "hello",
      "world",
      "```",
      "-/",
      "",
    ].join("\n");

    const blocks = parseVersoCommentBlocks(source, {
      defaultTitle(block) {
        return block.label ?? `Demo ${block.ordinal}`;
      },
      kind: "demo",
    });

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.key).toBe("demo:card");

    const serialized = serializeVersoCommentBlock(blocks[0]!, "demo", "alpha\nbeta");
    expect(serialized).toContain("/-!");
    expect(serialized).toContain("```demo card");
    expect(serialized).toContain("alpha");
    expect(serialized).toContain("beta");
  });

  it("builds adapters from the generic verso-comment adapter factory", () => {
    const adapter = createVersoCommentAdapter({
      defaultTitle(block: EmbeddedBlock) {
        return block.label ?? `Demo ${block.ordinal}`;
      },
      editorExtensions() {
        return [];
      },
      kind: "demo",
    });

    const blocks = adapter.parseBlocks(["/-!", "```demo sample", "alpha", "```", "-/", ""].join("\n"));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.key).toBe("demo:sample");
    expect(adapter.serializeBlock(blocks[0]!, "beta")).toContain("beta");
  });

  it("also recognizes /-- doc comments for editor-side detection", () => {
    const source = [
      "/--",
      "```rust demo",
      "fn add() {}",
      "```",
      "-/",
      "",
    ].join("\n");

    const blocks = parseEmbeddedRustBlocks(source);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.key).toBe("rust:demo");
  });

  it("parses CRLF verso-comment Rust blocks without corrupting offsets or code", () => {
    const source = "/-!\r\n```rust demo\r\nfn demo() {}\r\n```\r\n-/\r\n";

    const blocks = parseEmbeddedRustBlocks(source);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.from).toBe(0);
    expect(blocks[0]?.to).toBe(source.length);
    expect(blocks[0]?.code).toBe("fn demo() {}");
    expect(blocks[0]?.code.includes("\r")).toBe(false);
  });

  it("ignores incomplete fenced blocks", () => {
    expect(parseEmbeddedRustBlocks(["/-!", "```rust demo", "fn demo() {}", ""].join("\n"))).toEqual([]);
    expect(parseEmbeddedLeanBlocks(["//! ```lean demo", "//! #check Nat.succ", "not a comment"].join("\n"))).toEqual([]);
  });

  it("keeps duplicate labels addressable with stable generated keys", () => {
    const source = [
      "/-!",
      "```rust demo",
      "fn one() {}",
      "```",
      "-/",
      "/-!",
      "```rust demo",
      "fn two() {}",
      "```",
      "-/",
      "",
    ].join("\n");

    const blocks = parseEmbeddedRustBlocks(source);

    expect(blocks.map((block) => block.key)).toEqual(["rust:demo", "rust:demo#2"]);
    expect(blocks.map((block) => block.label)).toEqual(["demo", "demo"]);
  });

  it("parses Lean blocks from Rust line comments", () => {
    const source = [
      "pub fn add(a: u32, b: u32) -> u32 { a + b }",
      "",
      "//! ```lean prelude",
      "//! import Helper",
      "//! ```",
      "",
      "//! ```lean proof",
      "//! #check helperValue",
      "//! #check Nat.succ",
      "//! ```",
      "",
    ].join("\n");

    const blocks = parseEmbeddedLeanBlocks(source);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.key).toBe("lean:prelude");
    expect(blocks[0]?.role).toBe("prelude");
    expect(blocks[1]?.key).toBe("lean:proof");
    expect(blocks[1]?.code).toContain("#check helperValue");
  });

  it("parses CRLF Lean line-comment blocks with UTF-16-sensitive code offsets", () => {
    const source = "pub fn main() {}\r\n//! ```lean proof\r\n//! #check \"𝒜\"\r\n//! ```\r\n";

    const blocks = parseEmbeddedLeanBlocks(source);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.code).toBe("#check \"𝒜\"");
    expect(blocks[0]?.codeLineStarts?.[0]).toBe(source.indexOf("#check"));
    expect(blocks[0]?.code.includes("\r")).toBe(false);
  });

  it("serializes Lean snippets back into Rust comments", () => {
    const source = [
      "//! ```lean proof",
      "//! #check helperValue",
      "//! ```",
      "",
    ].join("\n");
    const block = parseEmbeddedLeanBlocks(source)[0];
    expect(block).toBeDefined();

    const serialized = serializeEmbeddedLeanBlock(block!, "#check Nat.succ");
    expect(serialized).toContain("//! ```lean proof");
    expect(serialized).toContain("//! #check Nat.succ");
    expect(serialized).toContain("//! ```");
  });

  it("round-trips serialized embedded snippets through the parser", () => {
    const rust = parseEmbeddedRustBlocks(serializeEmbeddedRustBlock({
      code: "",
      from: 0,
      key: "rust:demo",
      label: "demo",
      ordinal: 1,
      title: "demo",
      to: 0,
    }, "fn demo() {\n    println!(\"hi\");\n}"));
    expect(rust[0]?.code).toBe("fn demo() {\n    println!(\"hi\");\n}");

    const lean = parseEmbeddedLeanBlocks(serializeEmbeddedLeanBlock({
      code: "",
      from: 0,
      indent: "",
      key: "lean:proof",
      label: "proof",
      linePrefix: "//!",
      ordinal: 1,
      role: "snippet",
      title: "proof",
      to: 0,
    }, "#check Nat.succ\n#eval 1"));
    expect(lean[0]?.code).toBe("#check Nat.succ\n#eval 1");
  });

  it("builds one Lean document from Rust-comment prelude and snippets", () => {
    const source = [
      "//! ```lean demo",
      "//! #check helperValue",
      "//! ```",
      "//! ```lean prelude",
      "//! import Helper",
      "//! ```",
      "",
    ].join("\n");

    const document = buildEmbeddedLeanDocument(source, {
      sourceName: "Main.rs",
    }).doc;

    expect(document.startsWith("/- prelude from Main.rs:4 -/\nimport Helper")).toBe(true);
    expect(document.indexOf("import Helper")).toBeLessThan(document.indexOf("#check helperValue"));
    expect(document).toContain("demo from Main.rs:1");
  });

  it("maps generated Lean diagnostics back to embedded block offsets", () => {
    const source = [
      "fn main() {}",
      "//! ```lean proof",
      "//! #check \"𝒜\"",
      "//! ```",
      "",
    ].join("\n");
    const document = buildEmbeddedLeanDocument(source, {
      sourceName: "Main.rs",
    });
    const mapping = document.mappings.find((item) => item.blockKey === "lean:proof");
    expect(mapping).toBeDefined();

    const diagnostics = mapEmbeddedLeanDiagnostics(document, [
      {
        message: "synthetic",
        range: {
          start: { line: mapping!.generatedLine, character: 8 },
          end: { line: mapping!.generatedLine, character: 10 },
        },
        severity: "error",
      },
    ]);

    expect(diagnostics.get("lean:proof")).toEqual([
      {
        from: 8,
        message: "synthetic",
        severity: "error",
        to: 10,
      },
    ]);
  });
});
