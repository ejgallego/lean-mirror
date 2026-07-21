export interface DiagnosticGenerationTicket {
  readonly generation: number;
  readonly version: number | null;
}

export class DiagnosticGenerationGate {
  private generation = 0;
  private syncedGeneration = -1;
  private syncedVersion: number | null = null;

  beginEdit(): number {
    this.generation += 1;
    return this.generation;
  }

  recordSync(version?: number): DiagnosticGenerationTicket {
    this.syncedGeneration = this.generation;
    this.syncedVersion = version ?? null;
    return this.ticket();
  }

  ticket(): DiagnosticGenerationTicket {
    return {
      generation: this.syncedGeneration,
      version: this.syncedVersion,
    };
  }

  acceptsPush(version?: number): boolean {
    if (this.syncedGeneration !== this.generation) {
      return false;
    }
    if (version === undefined) {
      return this.generation === 0;
    }
    return this.syncedVersion !== null && version === this.syncedVersion;
  }

  isCurrent(ticket: DiagnosticGenerationTicket): boolean {
    return (
      this.syncedGeneration === this.generation &&
      ticket.generation === this.syncedGeneration &&
      ticket.version === this.syncedVersion
    );
  }
}
