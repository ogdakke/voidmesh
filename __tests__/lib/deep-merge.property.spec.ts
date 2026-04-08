/**
 * Property-based tests for deepMerge.
 *
 * Tests algebraic properties: identity, null-deletion, undefined-preservation,
 * no-mutation, and array replacement semantics.
 */
import { describe, test, expect } from "vitest";
import fc from "fast-check";
import { deepMerge } from "#lib/deep-merge.ts";

// ── Arbitraries ─────────────────────────────────────────────────────

/** A record with known shape for predictable merge behavior */
const flatObj = () =>
  fc.record({
    a: fc.oneof(fc.integer(), fc.string(), fc.boolean()),
    b: fc.oneof(fc.integer(), fc.string(), fc.boolean()),
    c: fc.oneof(fc.integer(), fc.string(), fc.boolean()),
  });

const nestedObj = () =>
  fc.record({
    x: fc.integer(),
    y: fc.string(),
    nested: fc.record({
      p: fc.integer(),
      q: fc.string(),
    }),
  });

// ── Identity Properties ─────────────────────────────────────────────

describe("deepMerge", () => {
  test("merging with empty object is identity", () => {
    fc.assert(
      fc.property(flatObj(), (obj) => {
        const result = deepMerge(obj, {} as any);
        expect(result).toEqual(obj);
      }),
    );
  });

  test("merging with empty object preserves nested structure", () => {
    fc.assert(
      fc.property(nestedObj(), (obj) => {
        const result = deepMerge(obj, {} as any);
        expect(result).toEqual(obj);
      }),
    );
  });

  // ── Overwrite Properties ────────────────────────────────────────

  test("primitive values in updates replace existing", () => {
    fc.assert(
      fc.property(flatObj(), fc.integer(), (obj, newVal) => {
        const result = deepMerge(obj, { a: newVal } as any);
        expect(result.a).toBe(newVal);
        // Other keys untouched
        expect(result.b).toBe(obj.b);
        expect(result.c).toBe(obj.c);
      }),
    );
  });

  // ── No Mutation ─────────────────────────────────────────────────

  test("does not mutate the original object", () => {
    fc.assert(
      fc.property(flatObj(), fc.integer(), (obj, newVal) => {
        const originalA = obj.a;
        deepMerge(obj, { a: newVal } as any);
        expect(obj.a).toBe(originalA);
      }),
    );
  });

  test("does not mutate nested objects", () => {
    fc.assert(
      fc.property(nestedObj(), fc.integer(), (obj, newP) => {
        const originalP = obj.nested.p;
        const originalQ = obj.nested.q;
        deepMerge(obj, { nested: { p: newP } } as any);
        expect(obj.nested.p).toBe(originalP);
        expect(obj.nested.q).toBe(originalQ);
      }),
    );
  });

  // ── undefined Preservation ──────────────────────────────────────

  test("undefined values in updates preserve existing values", () => {
    fc.assert(
      fc.property(flatObj(), (obj) => {
        const result = deepMerge(obj, { a: undefined } as any);
        expect(result.a).toBe(obj.a);
      }),
    );
  });

  // ── null Deletion ───────────────────────────────────────────────

  test("null values in updates set field to undefined", () => {
    fc.assert(
      fc.property(flatObj(), (obj) => {
        const result = deepMerge(obj, { a: null } as any);
        expect(result.a).toBeUndefined();
      }),
    );
  });

  // ── Array Replacement ───────────────────────────────────────────

  test("arrays are replaced, not merged", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer(), { minLength: 1, maxLength: 5 }),
        fc.array(fc.integer(), { minLength: 1, maxLength: 5 }),
        (arr1, arr2) => {
          const obj = { items: arr1 };
          const result = deepMerge(obj, { items: arr2 } as any);
          expect(result.items).toEqual(arr2);
          // Original array untouched
          expect(obj.items).toEqual(arr1);
        },
      ),
    );
  });

  // ── Recursive Merge ─────────────────────────────────────────────

  test("nested objects are recursively merged", () => {
    fc.assert(
      fc.property(nestedObj(), fc.integer(), (obj, newP) => {
        const result = deepMerge(obj, { nested: { p: newP } } as any);
        // Updated field
        expect(result.nested.p).toBe(newP);
        // Preserved field
        expect(result.nested.q).toBe(obj.nested.q);
      }),
    );
  });

  // ── Result has same keys as existing ────────────────────────────

  test("result preserves all existing keys", () => {
    fc.assert(
      fc.property(flatObj(), (obj) => {
        const result = deepMerge(obj, {} as any);
        const existingKeys = Object.keys(obj);
        const resultKeys = Object.keys(result);
        for (const key of existingKeys) {
          expect(resultKeys).toContain(key);
        }
      }),
    );
  });
});
