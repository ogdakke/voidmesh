import type { StudioManifest } from "./types.ts";
import { CURRENT_VERSION } from "./version.ts";

type Migration = (doc: Record<string, unknown>) => Record<string, unknown>;

/**
 * Migration registry. Each entry migrates from version N to N+1.
 * Key is the SOURCE version.
 */
const migrations: Record<number, Migration> = {
  // Version 1 -> 2: Add reversePalette field to ShaderParams
  1: (doc) => {
    for (const entity of doc.entities as any[]) {
      if (entity.shaderParams) {
        entity.shaderParams.reversePalette = entity.shaderParams.reversePalette ?? false;
      }
    }
    doc.version = 2;
    return doc;
  },
};

/**
 * Run all necessary migrations to bring a document to CURRENT_VERSION.
 * Returns a new object (does not mutate the input).
 */
export function runMigrations(doc: StudioManifest): StudioManifest {
  let current = structuredClone(doc) as unknown as Record<string, unknown>;

  while ((current.version as number) < CURRENT_VERSION) {
    const version = current.version as number;
    const migration = migrations[version];
    if (!migration) {
      throw new Error(
        `No migration found for version ${version}. Cannot migrate to v${CURRENT_VERSION}.`,
      );
    }
    current = migration(current);
  }

  return current as unknown as StudioManifest;
}
