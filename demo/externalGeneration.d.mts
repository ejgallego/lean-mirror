export interface AnnealGenerationInfo {
  annealArgs: string[];
  key: string;
  registryPath: string;
  rustRelativePath: string;
  targetDir: string;
}

export interface AnnealGenerationMetadata {
  annealArgs: string[];
  buildCompletedAt: string | null;
  key: string;
  leanRoot: string;
  registeredAt: string;
  rustRelativePath: string;
  schemaVersion: number;
}

export interface ComputeAnnealGenerationOptions {
  annealArgs: readonly string[];
  annealToolchainDir?: string | undefined;
  cargoHome?: string | undefined;
  rustRelativePath: string;
  rustSourcePath: string;
  targetManifestPath: string;
  toolManifestPath: string;
  xdgCacheHome?: string | undefined;
}

export function rustEmbeddedLeanHostFingerprint(source: string): string;
export function generationMetadataPath(leanRoot: string): string;
export function hasBuiltLeanArtifacts(leanRoot: string): Promise<boolean>;
export function readAnnealGenerationMetadata(leanRoot: string): Promise<AnnealGenerationMetadata | null>;
export function computeAnnealGenerationInfo(
  options: ComputeAnnealGenerationOptions,
): Promise<AnnealGenerationInfo>;
export function findReusableAnnealGeneration(
  info: AnnealGenerationInfo,
): Promise<AnnealGenerationMetadata | null>;
export function registerAnnealGeneration(
  info: AnnealGenerationInfo,
  leanRoot: string,
): Promise<AnnealGenerationMetadata>;
export function markAnnealGenerationBuilt(
  info: AnnealGenerationInfo,
  leanRoot: string,
): Promise<AnnealGenerationMetadata>;
