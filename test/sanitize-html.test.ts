import { describe, expect, it } from "vitest";

import { sanitizeHtml } from "../demo/src/sanitizeHtml.js";

describe("demo HTML sanitizer", () => {
  it("removes executable markup and unsafe attributes", () => {
    const sanitized = sanitizeHtml(
      '<p onclick="alert(1)">safe<img src=x onerror="alert(2)"></p>' +
        '<script>alert(3)</script><svg><a href="javascript:alert(4)">bad</a></svg>',
    );

    expect(sanitized).toBe("<p>safe</p>");
  });

  it("preserves safe documentation markup and links", () => {
    expect(
      sanitizeHtml(
        '<pre class="cm"><code class="tok-keyword">def</code></pre>' +
          '<a href="https://lean-lang.org" title="Lean" target="_blank">Lean</a>',
      ),
    ).toBe(
      '<pre class="cm"><code class="tok-keyword">def</code></pre>' +
        '<a href="https://lean-lang.org" title="Lean">Lean</a>',
    );
  });

  it("removes dangerous link schemes", () => {
    expect(sanitizeHtml('<a href="javascript:alert(1)">click</a>')).toBe("<a>click</a>");
  });
});
