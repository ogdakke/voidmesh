# serialization

Save and restore canvas state as `.vdmsh` zip archives.

## Archive format

A `.vdmsh` file is a zip containing:

```
manifest.json     # viewport + entity metadata (versioned)
media/
  assets/<asset-id>-<revision>.<ext> # shared images (original encoded bytes)
  <entity-id>.mp4   # videos (original bytes)
  <entity-id>.gif   # GIFs (original bytes)
```

`manifest.json` schema: `StudioManifest` (see `types.ts`), currently **v6**. Each entity records the MIME type of the exact bytes at `mediaFile`.

Multiple image entities may reference the same `mediaFile`. Serialization writes the original encoded Blob once per shared image asset, and deserialization restores one reference-counted `MediaImageAsset` for every repeated path.

Import validates and decodes into staged ownership first. The live workspace is replaced only when the caller adopts the complete decoded batch; aborts and pre-adoption failures dispose the staged media without changing live state.

## API

```ts
import { serialize, deserialize, getMaxCounters } from "./index.ts";

// Save
const blob: Blob = await serialize();

// Load — decoding stays staged until the owner adopts the complete workspace
const result = await deserialize(blob, (workspace) => {
  workspace.adopt((entities, viewport) => {
    canvasStore.restoreWorkspace(entities, viewport);
  });
  paletteStore.mergePalettes(workspace.palettes);
});
// result: { success, entityCount, warnings, errors[] }

// After load, sync canvas ID/zIndex counters
const { maxId, maxZIndex } = getMaxCounters(result);
```

## Migrations

`migrations.ts` holds a registry of version-stepping functions (N → N+1).
`runMigrations` is called automatically during `deserialize` when the document version is below `CURRENT_VERSION`.

To add a migration: add an entry keyed by the **source** version and bump `CURRENT_VERSION` in `version.ts`.

## Files

| File             | Purpose                                |
| ---------------- | -------------------------------------- |
| `serialize.ts`   | Canvas → zip Blob                      |
| `deserialize.ts` | zip Blob/ArrayBuffer → canvas          |
| `media.ts`       | Low-level bitmap/video byte conversion |
| `migrations.ts`  | Schema version migration registry      |
| `types.ts`       | Serialized types + type guards         |
| `version.ts`     | `CURRENT_VERSION` constant             |
