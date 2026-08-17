import { describe, it, expect } from 'vitest';
import { isSelectionDragSnapPoint } from '../js/utils/selection-drag-snap';

describe('isSelectionDragSnapPoint', () => {
  it('is always a valid snap point when the index is not selected', () => {
    const selected = new Set([3, 4, 5]);
    expect(isSelectionDragSnapPoint(selected, 10)).toBe(true);
    expect(isSelectionDragSnapPoint(selected, 0)).toBe(true);
  });

  it('is a valid snap point at the start of a contiguous run', () => {
    const selected = new Set([3, 4, 5, 6, 7, 8, 9, 10]);
    expect(isSelectionDragSnapPoint(selected, 3)).toBe(true);
  });

  it('is a valid snap point at the end of a contiguous run', () => {
    const selected = new Set([3, 4, 5, 6, 7, 8, 9, 10]);
    expect(isSelectionDragSnapPoint(selected, 10)).toBe(true);
  });

  it('is NOT a valid snap point in the middle of a contiguous run', () => {
    const selected = new Set([3, 4, 5, 6, 7, 8, 9, 10]);
    for (const i of [4, 5, 6, 7, 8, 9]) {
      expect(isSelectionDragSnapPoint(selected, i)).toBe(false);
    }
  });

  it('treats an isolated (singleton) selected page as a valid snap point', () => {
    const selected = new Set([7]);
    expect(isSelectionDragSnapPoint(selected, 7)).toBe(true);
  });

  it('matches the two-range example from the bug report: {3..10, 12..15}', () => {
    const selected = new Set([3, 4, 5, 6, 7, 8, 9, 10, 12, 13, 14, 15]);
    const validPoints = [3, 10, 12, 15];
    const invalidPoints = [4, 5, 6, 7, 8, 9, 13, 14];

    for (const i of validPoints) {
      expect(isSelectionDragSnapPoint(selected, i)).toBe(true);
    }
    for (const i of invalidPoints) {
      expect(isSelectionDragSnapPoint(selected, i)).toBe(false);
    }
  });

  it('handles a selection starting at index 0 without underflow issues', () => {
    const selected = new Set([0, 1, 2]);
    expect(isSelectionDragSnapPoint(selected, 0)).toBe(true);
    expect(isSelectionDragSnapPoint(selected, 1)).toBe(false);
    expect(isSelectionDragSnapPoint(selected, 2)).toBe(true);
  });

  it('treats every index as valid when the selection is empty', () => {
    const selected = new Set<number>();
    expect(isSelectionDragSnapPoint(selected, 5)).toBe(true);
  });
});
