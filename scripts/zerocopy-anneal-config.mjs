import { join } from "node:path";

export const zerocopyAnnealExamples = [
  {
    annealArgs: ["--example", "linked_list", "--allow-sorry"],
    id: "linked_list",
    label: "linked_list.rs",
    rustFile: "anneal/examples/linked_list.rs",
    summary: "Method spec over a recursive list model with local helper definitions.",
  },
  {
    annealArgs: ["--example", "namespaces", "--allow-sorry"],
    id: "namespaces",
    label: "namespaces.rs",
    rustFile: "anneal/examples/namespaces.rs",
    summary: "Nested Rust modules that become nested Lean namespaces.",
  },
  {
    annealArgs: ["--example", "size_of_align_of", "--allow-sorry"],
    id: "size_of_align_of",
    label: "size_of_align_of.rs",
    rustFile: "anneal/examples/size_of_align_of.rs",
    summary: "Several Rust doc-comment specs over layout and alignment queries.",
  },
  {
    annealArgs: ["--example", "abs", "--allow-sorry"],
    id: "abs",
    label: "abs.rs",
    rustFile: "anneal/examples/abs.rs",
    summary: "Single-function absolute-value example with a scalar arithmetic proof.",
  },
];

export const zerocopyAnnealDescriptor = {
  project: "google/zerocopy PR 3321 / Anneal / Lean 4 / CodeMirror 6",
  summary:
    "This demo opens Rust examples from the zerocopy PR, mirrors `lean, anneal, spec` doc comments into a hidden Lean file, and checks them against the Anneal-generated Lean workspace while rust-analyzer stays attached to the host Rust source.",
  title: "Zerocopy Anneal Embedded Lean Demo",
};

export function createZerocopyAnnealDemoEnv(checkoutRoot, env = process.env) {
  return {
    ...env,
    LEAN_DEMO_ANNEAL_MANIFEST: join(checkoutRoot, "anneal", "Cargo.toml"),
    LEAN_DEMO_EXAMPLE_PRESETS: JSON.stringify(zerocopyAnnealExamples),
    LEAN_DEMO_PROJECT: zerocopyAnnealDescriptor.project,
    LEAN_DEMO_RUST_ROOT: checkoutRoot,
    LEAN_DEMO_SUMMARY: zerocopyAnnealDescriptor.summary,
    LEAN_DEMO_TITLE: zerocopyAnnealDescriptor.title,
  };
}
