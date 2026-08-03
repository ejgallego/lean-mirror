export const zerocopyPr3321Examples = [
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

export function parseExternalAnnealArgs(value) {
  if (!value) {
    return [];
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return [];
  }
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
      throw new Error("LEAN_DEMO_ANNEAL_ARGS JSON must be a string array.");
    }
    return parsed;
  }
  return trimmed.split(/\s+/);
}

export function resolveExternalExamplePresets({ defaultExternalAnnealArgs, externalExampleSet, env }) {
  if (env.LEAN_DEMO_EXAMPLE_PRESETS) {
    const parsed = JSON.parse(env.LEAN_DEMO_EXAMPLE_PRESETS);
    if (!Array.isArray(parsed)) {
      throw new Error("LEAN_DEMO_EXAMPLE_PRESETS must be a JSON array.");
    }
    return parsed.map((entry, index) => {
      if (!entry || typeof entry !== "object") {
        throw new Error(`LEAN_DEMO_EXAMPLE_PRESETS[${index}] must be an object.`);
      }
      if (typeof entry.id !== "string" || entry.id.length === 0) {
        throw new Error(`LEAN_DEMO_EXAMPLE_PRESETS[${index}].id must be a non-empty string.`);
      }
      if (typeof entry.rustFile !== "string" || entry.rustFile.length === 0) {
        throw new Error(`LEAN_DEMO_EXAMPLE_PRESETS[${index}].rustFile must be a non-empty string.`);
      }
      if (
        entry.annealArgs !== undefined &&
        (!Array.isArray(entry.annealArgs) || entry.annealArgs.some((item) => typeof item !== "string"))
      ) {
        throw new Error(`LEAN_DEMO_EXAMPLE_PRESETS[${index}].annealArgs must be a string array.`);
      }
      return {
        annealArgs: entry.annealArgs ?? defaultExternalAnnealArgs,
        id: entry.id,
        label: typeof entry.label === "string" ? entry.label : entry.id,
        rustFile: entry.rustFile,
        summary: typeof entry.summary === "string" ? entry.summary : "",
      };
    });
  }
  return externalExampleSet === "zerocopy-pr3321" ? zerocopyPr3321Examples : [];
}

export function resolveInitialExternalExampleId({ env, externalExamplePresets, initialExternalRustFile }) {
  if (externalExamplePresets.length === 0) {
    return null;
  }
  const explicit = env.LEAN_DEMO_ACTIVE_EXAMPLE;
  if (explicit && externalExamplePresets.some((entry) => entry.id === explicit)) {
    return explicit;
  }
  const matchingRustFile = externalExamplePresets.find((entry) => entry.rustFile === initialExternalRustFile);
  return matchingRustFile?.id ?? externalExamplePresets[0]?.id ?? null;
}
