export interface SynthesizedArtifact {
  spec_yaml: string;
  mode_names: string[];
  sha256: string;
  created_at: string;
}

const artifactsBySessionId = new Map<string, SynthesizedArtifact>();

export function putSynthesizedArtifact(sessionId: string, artifact: SynthesizedArtifact): void {
  artifactsBySessionId.set(sessionId, artifact);
}

export function getSynthesizedArtifact(sessionId: string): SynthesizedArtifact | undefined {
  return artifactsBySessionId.get(sessionId);
}

export function clearSynthesizedArtifact(sessionId: string): void {
  artifactsBySessionId.delete(sessionId);
}

export function requireSynthesizedArtifact(sessionId: string): SynthesizedArtifact {
  const artifact = getSynthesizedArtifact(sessionId);
  if (!artifact) {
    throw new Error(`synthesized spec not in transit for session ${sessionId}; re-run synthesize_program_spec`);
  }
  return artifact;
}
