import { boundsIntersect, getRotatedAABB } from "#lib/canvas-math.ts";
import type { Bounds, ShaderCanvasEntity } from "#types/canvas.ts";

interface SpatialLevel {
  cellSize: number;
  rows: Map<number, Map<number, Set<IndexedEntity>>>;
  cellCount: number;
}

interface IndexedEntity {
  entity: ShaderCanvasEntity;
  bounds: Bounds;
  level: SpatialLevel;
  cellX: number;
  cellY: number;
}

const DEFAULT_CELL_SIZE = 256;

/** Incremental multi-resolution broad-phase index for viewport and point queries. */
export class EntitySpatialIndex {
  readonly #minimumCellSize: number;
  readonly #levels = new Map<number, SpatialLevel>();
  readonly #entries = new Map<string, IndexedEntity>();

  constructor(minimumCellSize = DEFAULT_CELL_SIZE) {
    this.#minimumCellSize = minimumCellSize;
  }

  upsert(entity: ShaderCanvasEntity): void {
    let entry = this.#entries.get(entity.id);
    if (entry) this.#removeFromCell(entry);

    const bounds = getRotatedAABB(
      entity.position,
      entity.size,
      entity.rotation,
      entry?.bounds ?? { x: 0, y: 0, width: 0, height: 0 },
    );
    const level = this.#getLevel(this.#getCellSize(bounds));
    const cellX = this.#cellCoordinate(bounds.x + bounds.width / 2, level.cellSize);
    const cellY = this.#cellCoordinate(bounds.y + bounds.height / 2, level.cellSize);

    if (!entry) {
      entry = { entity, bounds, level, cellX, cellY };
      this.#entries.set(entity.id, entry);
    } else {
      entry.entity = entity;
      entry.level = level;
      entry.cellX = cellX;
      entry.cellY = cellY;
    }

    let row = level.rows.get(cellY);
    if (!row) {
      row = new Map();
      level.rows.set(cellY, row);
    }
    let ids = row.get(cellX);
    if (!ids) {
      ids = new Set();
      row.set(cellX, ids);
      level.cellCount++;
    }
    ids.add(entry);
  }

  remove(entityId: string): void {
    const entry = this.#entries.get(entityId);
    if (!entry) return;
    this.#removeFromCell(entry);
    this.#entries.delete(entityId);
  }

  clear(): void {
    this.#levels.clear();
    this.#entries.clear();
  }

  queryBounds(bounds: Bounds, output: ShaderCanvasEntity[]): ShaderCanvasEntity[] {
    output.length = 0;
    for (const level of this.#levels.values()) this.#queryLevel(level, bounds, output);
    if (!isEntityZOrdered(output)) output.sort(compareEntityZIndex);
    return output;
  }

  #queryLevel(level: SpatialLevel, bounds: Bounds, output: ShaderCanvasEntity[]): void {
    // Each entity AABB is no larger than its level's cell. Its center can therefore
    // sit at most half a cell outside the query while the AABB still intersects it.
    const margin = level.cellSize / 2;
    const minCellX = this.#cellCoordinate(bounds.x - margin, level.cellSize);
    const minCellY = this.#cellCoordinate(bounds.y - margin, level.cellSize);
    const maxCellX = this.#cellCoordinate(bounds.x + bounds.width + margin, level.cellSize);
    const maxCellY = this.#cellCoordinate(bounds.y + bounds.height + margin, level.cellSize);
    const queryCellCount = (maxCellX - minCellX + 1) * (maxCellY - minCellY + 1);

    if (queryCellCount <= level.cellCount * 2) {
      for (let cellY = minCellY; cellY <= maxCellY; cellY++) {
        const row = level.rows.get(cellY);
        if (!row) continue;
        for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
          const entries = row.get(cellX);
          if (entries) this.#appendIntersecting(entries, bounds, output);
        }
      }
      return;
    }

    for (const [cellY, row] of level.rows) {
      if (cellY < minCellY || cellY > maxCellY) continue;
      for (const [cellX, entries] of row) {
        if (cellX < minCellX || cellX > maxCellX) continue;
        this.#appendIntersecting(entries, bounds, output);
      }
    }
  }

  #appendIntersecting(
    entries: ReadonlySet<IndexedEntity>,
    bounds: Bounds,
    output: ShaderCanvasEntity[],
  ): void {
    for (const entry of entries) {
      if (boundsIntersect(entry.bounds, bounds)) output.push(entry.entity);
    }
  }

  #getCellSize(bounds: Bounds): number {
    const extent = Math.max(this.#minimumCellSize, bounds.width, bounds.height);
    return 2 ** Math.ceil(Math.log2(extent));
  }

  #getLevel(cellSize: number): SpatialLevel {
    let level = this.#levels.get(cellSize);
    if (level) return level;
    level = { cellSize, rows: new Map(), cellCount: 0 };
    this.#levels.set(cellSize, level);
    return level;
  }

  #cellCoordinate(value: number, cellSize: number): number {
    return Math.floor(value / cellSize);
  }

  #removeFromCell(entry: IndexedEntity): void {
    const { level } = entry;
    const row = level.rows.get(entry.cellY);
    const ids = row?.get(entry.cellX);
    if (!row || !ids) return;
    ids.delete(entry);
    if (ids.size > 0) return;
    row.delete(entry.cellX);
    level.cellCount--;
    if (row.size === 0) level.rows.delete(entry.cellY);
    if (level.cellCount === 0) this.#levels.delete(level.cellSize);
  }
}

function compareEntityZIndex(left: ShaderCanvasEntity, right: ShaderCanvasEntity): number {
  return left.zIndex - right.zIndex;
}

function isEntityZOrdered(entities: readonly ShaderCanvasEntity[]): boolean {
  for (let index = 1; index < entities.length; index++) {
    if (entities[index - 1]!.zIndex > entities[index]!.zIndex) return false;
  }
  return true;
}
