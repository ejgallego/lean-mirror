import { describe, expect, it } from "vitest";
import { renderRustPreview } from "../demo/src/rustPreview.js";
import { parseEmbeddedRustBlocks, serializeEmbeddedRustBlock } from "../demo/src/embeddedRust.js";

describe("Rosetta comment preview", () => {
  it("edits either Rust fence without replacing Verso prose or its other fence", () => {
    const source = '/-!\nBefore 𝒜.\n\n```rust (name := first)\nfn first() {}\n```\n\nBetween.\n```rust (name := second)\nfn second() {}\n```\nAfter.\n-/\n';
    const blocks = parseEmbeddedRustBlocks(source);
    expect(blocks).toHaveLength(2);
    const target = blocks[1]!;
    const changed = source.slice(0, target.from) + serializeEmbeddedRustBlock(target, "fn edited() {}") + source.slice(target.to);
    expect(changed).toBe(source.replace("fn second() {}", "fn edited() {}"));
    expect(parseEmbeddedRustBlocks(changed).map(block => block.code)).toEqual(["fn first() {}", "fn edited() {}"]);
  });

  it("renders source and server facts as text while respecting UTF-16 ranges", async () => {
    const host = document.createElement("div");
    const source = '// 𝒜\nfn call() { /* <img src=x onerror=alert(1)> */ }';
    renderRustPreview(host, source, [{
      range: { start: { line: 1, character: 3 }, end: { line: 1, character: 7 } }, tokenType: "function",
    }], async () => '<script>alert("unsafe")</script>');
    document.body.append(host);
    expect(host.textContent).toBe(source);
    expect(host.querySelector("img")).toBeNull();
    const token = host.querySelector<HTMLElement>("[data-rosetta-token]")!;
    expect(token.textContent).toBe("call");
    token.dispatchEvent(new MouseEvent("mouseenter"));
    await Promise.resolve();
    expect(token.title).toContain("<script>");
    expect(host.querySelector("script")).toBeNull();
    host.remove();
  });
});
