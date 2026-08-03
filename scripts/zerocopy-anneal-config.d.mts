export interface ZerocopyAnnealExample {
  annealArgs: readonly string[];
  id: string;
  label: string;
  rustFile: string;
  summary: string;
}

export interface ZerocopyAnnealDescriptor {
  project: string;
  summary: string;
  title: string;
}

export interface ZerocopyAnnealDemoEnv extends Record<string, string | undefined> {
  LEAN_DEMO_ANNEAL_MANIFEST: string;
  LEAN_DEMO_EXAMPLE_PRESETS: string;
  LEAN_DEMO_PROJECT: string;
  LEAN_DEMO_RUST_ROOT: string;
  LEAN_DEMO_SUMMARY: string;
  LEAN_DEMO_TITLE: string;
}

export const zerocopyAnnealExamples: readonly ZerocopyAnnealExample[];
export const zerocopyAnnealDescriptor: Readonly<ZerocopyAnnealDescriptor>;

export function createZerocopyAnnealDemoEnv(
  checkoutRoot: string,
  env?: Record<string, string | undefined>,
): ZerocopyAnnealDemoEnv;
