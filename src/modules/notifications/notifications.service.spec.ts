import { stableStringify } from './notifications.service';

/**
 * The dedup key is a content hash, so the serialisation feeding it has to be canonical.
 * `JSON.stringify` is not: two producers building the same logical event with keys in a different
 * order would hash differently and both sends would go out.
 */
describe('stableStringify', () => {
  it('is insensitive to object key order', () => {
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
  });

  it('differs from JSON.stringify on reordered keys', () => {
    // Demonstrates the bug this function exists to avoid.
    expect(JSON.stringify({ a: 1, b: 2 })).not.toBe(JSON.stringify({ b: 2, a: 1 }));
  });

  it('sorts keys recursively', () => {
    expect(stableStringify({ outer: { z: 1, a: 2 } })).toBe(
      stableStringify({ outer: { a: 2, z: 1 } }),
    );
  });

  it('preserves array order, which is semantically meaningful', () => {
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]));
  });

  it('sorts keys inside array elements', () => {
    expect(stableStringify([{ b: 1, a: 2 }])).toBe(stableStringify([{ a: 2, b: 1 }]));
  });

  it('ignores undefined values, matching JSON semantics', () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe(stableStringify({ a: 1 }));
  });

  it('distinguishes null from absent', () => {
    expect(stableStringify({ a: null })).not.toBe(stableStringify({}));
  });

  it('handles primitives and nesting', () => {
    expect(stableStringify('x')).toBe('"x"');
    expect(stableStringify(42)).toBe('42');
    expect(stableStringify(null)).toBe('null');
    expect(stableStringify({ a: [{ c: 1, b: [2, 3] }] })).toBe('{"a":[{"b":[2,3],"c":1}]}');
  });
});
