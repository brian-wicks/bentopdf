import { describe, it, expect } from 'vitest';
import { moveSelectedPages } from '../js/utils/move-selected-pages';

describe('moveSelectedPages', () => {
  it('moves a single unselected page forward like a plain reorder', () => {
    const result = moveSelectedPages(['A', 'B', 'C', 'D'], new Set(), 0, 2);
    expect(result.items).toEqual(['B', 'C', 'A', 'D']);
    expect(result.selectedIndices).toEqual(new Set());
  });

  it('moves a single unselected page to the very front', () => {
    const result = moveSelectedPages(['A', 'B', 'C', 'D'], new Set(), 3, 0);
    expect(result.items).toEqual(['D', 'A', 'B', 'C']);
  });

  it('moves a single unselected page to the very end', () => {
    const result = moveSelectedPages(['A', 'B', 'C', 'D'], new Set(), 0, 3);
    expect(result.items).toEqual(['B', 'C', 'D', 'A']);
  });

  it('drags the only selected page: selection follows it to its new index', () => {
    const result = moveSelectedPages(['A', 'B', 'C', 'D'], new Set([0]), 0, 2);
    expect(result.items).toEqual(['B', 'C', 'A', 'D']);
    expect(result.selectedIndices).toEqual(new Set([2]));
  });

  it('dragging an unselected page still remaps indices of pages selected elsewhere', () => {
    const result = moveSelectedPages(
      ['A', 'B', 'C', 'D', 'E'],
      new Set([1, 3]), // B, D selected
      0, // dragging A (not selected)
      3
    );
    expect(result.items).toEqual(['B', 'C', 'D', 'A', 'E']);
    // B is now at index 0, D is now at index 2
    expect(result.selectedIndices).toEqual(new Set([0, 2]));
  });

  it('dragging one of several selected pages moves the whole group together, preserving relative order', () => {
    const result = moveSelectedPages(
      ['A', 'B', 'C', 'D', 'E', 'F', 'G'],
      new Set([1, 2, 4]), // B, C, E selected
      2, // dragging C
      5
    );
    expect(result.items).toEqual(['A', 'D', 'F', 'B', 'C', 'E', 'G']);
    expect(result.selectedIndices).toEqual(new Set([3, 4, 5]));
  });

  it('dragging a different member of the same group to the equivalent drop point yields the same result', () => {
    const result = moveSelectedPages(
      ['A', 'B', 'C', 'D', 'E', 'F', 'G'],
      new Set([1, 2, 4]), // B, C, E selected
      4, // dragging E this time, not C
      5
    );
    expect(result.items).toEqual(['A', 'D', 'F', 'B', 'C', 'E', 'G']);
    expect(result.selectedIndices).toEqual(new Set([3, 4, 5]));
  });

  it('moves a non-contiguous group backward to the front, preserving relative order', () => {
    const result = moveSelectedPages(
      ['A', 'B', 'C', 'D', 'E', 'F', 'G'],
      new Set([2, 4, 5]), // C, E, F selected
      4, // dragging E
      0
    );
    expect(result.items).toEqual(['C', 'E', 'F', 'A', 'B', 'D', 'G']);
    expect(result.selectedIndices).toEqual(new Set([0, 1, 2]));
  });

  it('moves a contiguous pair to the end together', () => {
    const result = moveSelectedPages(
      ['A', 'B', 'C', 'D', 'E'],
      new Set([0, 1]), // A, B selected
      0, // dragging A
      4
    );
    expect(result.items).toEqual(['C', 'D', 'E', 'A', 'B']);
    expect(result.selectedIndices).toEqual(new Set([3, 4]));
  });

  it('dropping inside an already-contiguous selected group at its own slot is a no-op', () => {
    const result = moveSelectedPages(
      ['A', 'B', 'C', 'D', 'E'],
      new Set([1, 2, 3]), // B, C, D selected, already contiguous
      2, // dragging C
      1
    );
    expect(result.items).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(result.selectedIndices).toEqual(new Set([1, 2, 3]));
  });

  it('selecting every page and dragging one leaves the order unchanged', () => {
    const result = moveSelectedPages(['A', 'B', 'C'], new Set([0, 1, 2]), 1, 0);
    expect(result.items).toEqual(['A', 'B', 'C']);
    expect(result.selectedIndices).toEqual(new Set([0, 1, 2]));
  });

  it('does not mutate the input array or selection set', () => {
    const items = ['A', 'B', 'C', 'D'];
    const selected = new Set([0, 1]);
    moveSelectedPages(items, selected, 0, 3);
    expect(items).toEqual(['A', 'B', 'C', 'D']);
    expect(selected).toEqual(new Set([0, 1]));
  });

  it('returns a new array and set instance rather than aliasing the inputs', () => {
    const items = ['A', 'B', 'C'];
    const selected = new Set([0]);
    const result = moveSelectedPages(items, selected, 0, 1);
    expect(result.items).not.toBe(items);
    expect(result.selectedIndices).not.toBe(selected);
  });
});
