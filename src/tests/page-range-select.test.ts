import { describe, it, expect } from 'vitest';
import {
  applyPageSelectClick,
  type PageSelectionState,
} from '../js/utils/page-range-select';

const emptyState: PageSelectionState = {
  selected: new Set(),
  anchorIndex: null,
  baselineSelection: null,
};

function stateFromResult(result: {
  selected: Set<number>;
  anchorIndex: number;
  baselineSelection: Set<number>;
}): PageSelectionState {
  return result;
}

describe('applyPageSelectClick', () => {
  it('plain click selects an unselected page', () => {
    const result = applyPageSelectClick(emptyState, 3, false);
    expect([...result.selected]).toEqual([3]);
    expect(result.anchorIndex).toBe(3);
    expect([...result.baselineSelection]).toEqual([3]);
  });

  it('plain click deselects an already-selected page', () => {
    const state: PageSelectionState = {
      selected: new Set([3]),
      anchorIndex: 3,
      baselineSelection: new Set([3]),
    };
    const result = applyPageSelectClick(state, 3, false);
    expect([...result.selected]).toEqual([]);
    expect(result.anchorIndex).toBe(3);
    expect([...result.baselineSelection]).toEqual([]);
  });

  it('plain click toggles a page without disturbing other selected pages', () => {
    const state: PageSelectionState = {
      selected: new Set([1, 2, 5]),
      anchorIndex: 1,
      baselineSelection: new Set([1, 2, 5]),
    };
    const result = applyPageSelectClick(state, 7, false);
    expect([...result.selected].sort()).toEqual([1, 2, 5, 7]);
    expect(result.anchorIndex).toBe(7);
  });

  it('plain click re-anchors on the clicked page', () => {
    const state: PageSelectionState = {
      selected: new Set([0]),
      anchorIndex: 0,
      baselineSelection: new Set([0]),
    };
    const result = applyPageSelectClick(state, 4, false);
    expect(result.anchorIndex).toBe(4);
  });

  it('shift+click with no prior anchor falls back to a plain toggle', () => {
    const result = applyPageSelectClick(emptyState, 5, true);
    expect([...result.selected]).toEqual([5]);
    expect(result.anchorIndex).toBe(5);
  });

  it('shift+click selects the forward range from anchor to target', () => {
    const state = stateFromResult(applyPageSelectClick(emptyState, 2, false));
    const result = applyPageSelectClick(state, 6, true);
    expect([...result.selected].sort((a, b) => a - b)).toEqual([2, 3, 4, 5, 6]);
    expect(result.anchorIndex).toBe(2);
  });

  it('shift+click selects the backward range when target precedes anchor', () => {
    const state = stateFromResult(applyPageSelectClick(emptyState, 6, false));
    const result = applyPageSelectClick(state, 2, true);
    expect([...result.selected].sort((a, b) => a - b)).toEqual([2, 3, 4, 5, 6]);
    expect(result.anchorIndex).toBe(6);
  });

  it('shift+click on the anchor itself selects just the anchor', () => {
    const state = stateFromResult(applyPageSelectClick(emptyState, 4, false));
    const result = applyPageSelectClick(state, 4, true);
    expect([...result.selected]).toEqual([4]);
    expect(result.anchorIndex).toBe(4);
  });

  it('keeps the anchor fixed across a chain of shift+clicks', () => {
    let state = stateFromResult(applyPageSelectClick(emptyState, 2, false));
    state = stateFromResult(applyPageSelectClick(state, 5, true));
    expect(state.anchorIndex).toBe(2);

    state = stateFromResult(applyPageSelectClick(state, 8, true));
    expect(state.anchorIndex).toBe(2);
    expect([...state.selected].sort((a, b) => a - b)).toEqual([
      2, 3, 4, 5, 6, 7, 8,
    ]);
  });

  it('shrinking a shift range deselects the pages that fall back out', () => {
    let state = stateFromResult(applyPageSelectClick(emptyState, 1, false));
    state = stateFromResult(applyPageSelectClick(state, 8, true));
    expect([...state.selected].sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);

    state = stateFromResult(applyPageSelectClick(state, 4, true));
    expect([...state.selected].sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
    expect(state.anchorIndex).toBe(1);
  });

  it('preserves pages selected before the shift sequence began', () => {
    // Pages 10 and 20 were selected independently (e.g. via individual
    // clicks earlier), then the user starts a fresh anchor at 2.
    const preExisting = new Set([10, 20]);
    let state: PageSelectionState = {
      selected: preExisting,
      anchorIndex: null,
      baselineSelection: null,
    };
    state = stateFromResult(applyPageSelectClick(state, 2, false));
    expect([...state.selected].sort((a, b) => a - b)).toEqual([2, 10, 20]);

    state = stateFromResult(applyPageSelectClick(state, 5, true));
    expect([...state.selected].sort((a, b) => a - b)).toEqual([
      2, 3, 4, 5, 10, 20,
    ]);
  });

  it('shrinking a shift range to nothing beyond the anchor still keeps the anchor selected', () => {
    let state = stateFromResult(applyPageSelectClick(emptyState, 3, false));
    state = stateFromResult(applyPageSelectClick(state, 9, true));
    state = stateFromResult(applyPageSelectClick(state, 3, true));
    expect([...state.selected]).toEqual([3]);
  });

  it('a plain click after a shift range starts a brand-new anchor and baseline', () => {
    let state = stateFromResult(applyPageSelectClick(emptyState, 2, false));
    state = stateFromResult(applyPageSelectClick(state, 6, true));
    // Plain click deselecting page 4 (currently selected via the range).
    state = stateFromResult(applyPageSelectClick(state, 4, false));
    expect([...state.selected].sort((a, b) => a - b)).toEqual([2, 3, 5, 6]);
    expect(state.anchorIndex).toBe(4);
    expect([...state.baselineSelection].sort((a, b) => a - b)).toEqual([
      2, 3, 5, 6,
    ]);

    // A subsequent shift+click now ranges from the new anchor (4), not the
    // old one (2).
    state = stateFromResult(applyPageSelectClick(state, 7, true));
    expect([...state.selected].sort((a, b) => a - b)).toEqual([
      2, 3, 4, 5, 6, 7,
    ]);
  });

  it('handles a single-page range (anchor equals target index 0)', () => {
    const result = applyPageSelectClick(emptyState, 0, false);
    expect([...result.selected]).toEqual([0]);
    const shiftResult = applyPageSelectClick(stateFromResult(result), 0, true);
    expect([...shiftResult.selected]).toEqual([0]);
  });

  it('does not mutate the input state objects', () => {
    const selected = new Set([1, 2]);
    const baselineSelection = new Set([1, 2]);
    const state: PageSelectionState = {
      selected,
      anchorIndex: 1,
      baselineSelection,
    };
    applyPageSelectClick(state, 5, true);
    expect([...selected].sort((a, b) => a - b)).toEqual([1, 2]);
    expect([...baselineSelection].sort((a, b) => a - b)).toEqual([1, 2]);
  });

  it('returns a new Set instance rather than aliasing the baseline', () => {
    const baselineSelection = new Set([1, 2, 3]);
    const state: PageSelectionState = {
      selected: new Set([1, 2, 3]),
      anchorIndex: 1,
      baselineSelection,
    };
    const result = applyPageSelectClick(state, 3, true);
    expect(result.selected).not.toBe(baselineSelection);
    result.selected.add(99);
    expect(baselineSelection.has(99)).toBe(false);
  });

  describe('exclusive mode (plain click on the page preview)', () => {
    it('selects only the clicked page, clearing any other selection', () => {
      const state: PageSelectionState = {
        selected: new Set([1, 2, 5]),
        anchorIndex: 1,
        baselineSelection: new Set([1, 2, 5]),
      };
      const result = applyPageSelectClick(state, 3, false, 'exclusive');
      expect([...result.selected]).toEqual([3]);
      expect(result.anchorIndex).toBe(3);
      expect([...result.baselineSelection]).toEqual([3]);
    });

    it('clicking an already-selected page keeps only that page selected (not a toggle-off)', () => {
      const state: PageSelectionState = {
        selected: new Set([1, 2, 3]),
        anchorIndex: 1,
        baselineSelection: new Set([1, 2, 3]),
      };
      const result = applyPageSelectClick(state, 2, false, 'exclusive');
      expect([...result.selected]).toEqual([2]);
    });

    it('sets the clicked page as the new anchor for a following shift+click', () => {
      let state: PageSelectionState = {
        selected: new Set([5, 6]),
        anchorIndex: 5,
        baselineSelection: new Set([5, 6]),
      };
      state = applyPageSelectClick(state, 1, false, 'exclusive');
      const shiftResult = applyPageSelectClick(state, 4, true);
      expect([...shiftResult.selected].sort((a, b) => a - b)).toEqual([
        1, 2, 3, 4,
      ]);
    });

    it('ctrl/cmd-click (mode toggle) adds the page without clearing the rest, unlike a plain exclusive click', () => {
      const state: PageSelectionState = {
        selected: new Set([1, 2]),
        anchorIndex: 1,
        baselineSelection: new Set([1, 2]),
      };
      const result = applyPageSelectClick(state, 5, false, 'toggle');
      expect([...result.selected].sort((a, b) => a - b)).toEqual([1, 2, 5]);
    });

    it('shift+click still takes priority over exclusive mode', () => {
      let state: PageSelectionState = {
        selected: new Set(),
        anchorIndex: null,
        baselineSelection: null,
      };
      state = applyPageSelectClick(state, 2, false, 'exclusive');
      const result = applyPageSelectClick(state, 5, true, 'exclusive');
      expect([...result.selected].sort((a, b) => a - b)).toEqual([2, 3, 4, 5]);
    });
  });
});
