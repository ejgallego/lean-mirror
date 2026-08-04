import { resolve } from "node:path";

export function leanMirrorSourceAliases(repositoryRoot: string): Record<string, string> {
  return {
    "@leanprover/editor-platform": resolve(
      repositoryRoot,
      "packages/editor-platform/src/index.ts",
    ),
    "@leanprover/infoview": resolve(
      repositoryRoot,
      "node_modules/@leanprover/infoview/dist/index.production.min.js",
    ),
    "codemirror-lean4-lsp/infoview": resolve(repositoryRoot, "src/infoview.ts"),
    "codemirror-lean4-lsp/infoview.css": resolve(
      repositoryRoot,
      "node_modules/@leanprover/infoview/dist/index.css",
    ),
    "codemirror-lean4-lsp": resolve(repositoryRoot, "src/index.ts"),
    "react/jsx-runtime": resolve(
      repositoryRoot,
      "node_modules/@leanprover/infoview/dist/react-jsx-runtime.production.min.js",
    ),
    "react-dom": resolve(
      repositoryRoot,
      "node_modules/@leanprover/infoview/dist/react-dom.production.min.js",
    ),
    react: resolve(
      repositoryRoot,
      "node_modules/@leanprover/infoview/dist/react.production.min.js",
    ),
  };
}
