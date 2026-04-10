import type { LegacySerializedEntity, LegacyStudioManifest, StudioManifest } from "./types.ts";
import { CURRENT_VERSION } from "./version.ts";

type Migration = (doc: Record<string, unknown>) => Record<string, unknown>;

function migrateLegacyEntity(entity: LegacySerializedEntity) {
  const assetId = `asset-${entity.id}`;

  const baseEntity = {
    id: entity.id,
    assetId,
    name: entity.name,
    position: entity.position,
    size: entity.size,
    originalSize: entity.originalSize,
    zIndex: entity.zIndex,
    rotation: entity.rotation,
    locked: entity.locked,
    edited: entity.edited,
    shaderType: entity.shaderType,
    shaderParams: entity.shaderParams,
    ...(entity.originalPalette && { originalPalette: entity.originalPalette }),
    ...("playback" in entity && entity.playback ? { playback: entity.playback } : {}),
  };

  const baseAsset = {
    assetId,
    mediaType: entity.mediaType,
    mediaFile: entity.mediaFile,
    width: entity.originalSize.width,
    height: entity.originalSize.height,
  };

  switch (entity.mediaType) {
    case "image":
    case "svg":
      return { asset: baseAsset, entity: baseEntity };
    case "video":
      return {
        asset: {
          ...baseAsset,
          duration: entity.duration,
          fps: entity.fps,
          hasAudio: entity.hasAudio ?? false,
        },
        entity: baseEntity,
      };
    case "gif":
      return {
        asset: {
          ...baseAsset,
          duration: entity.duration,
          fps: entity.fps,
        },
        entity: baseEntity,
      };
  }
}

const migrations: Record<number, Migration> = {
  1: (doc) => {
    for (const entity of doc.entities as Array<Record<string, unknown>>) {
      if (entity.shaderParams && typeof entity.shaderParams === "object") {
        entity.shaderParams = {
          ...(entity.shaderParams as Record<string, unknown>),
          reversePalette: (entity.shaderParams as Record<string, unknown>).reversePalette ?? false,
        };
      }
    }
    doc.version = 2;
    return doc;
  },
  2: (doc) => {
    doc.version = 3;
    return doc;
  },
  3: (doc) => {
    doc.version = 4;
    return doc;
  },
  4: (doc) => {
    const legacy = doc as unknown as LegacyStudioManifest;
    const assets = [];
    const entities = [];

    for (const entity of legacy.entities) {
      const migrated = migrateLegacyEntity(entity);
      assets.push(migrated.asset);
      entities.push(migrated.entity);
    }

    return {
      ...legacy,
      version: 5,
      assets,
      entities,
    };
  },
};

export function runMigrations(doc: StudioManifest | LegacyStudioManifest): StudioManifest {
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
