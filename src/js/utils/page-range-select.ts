/**
 * Windows-Explorer-style click/shift-click selection.
 *
 * Plain click toggles the target page and re-anchors on it. Shift+click
 * recomputes the selection from a baseline snapshot taken when the anchor
 * was set, plus the anchor..target range — so extending the range grows
 * the selection, and pulling it back in deselects pages that fall back out.
 */

export interface PageSelectionState {
  selected: ReadonlySet<number>;
  anchorIndex: number | null;
  baselineSelection: ReadonlySet<number> | null;
}

export interface PageSelectionResult {
  selected: Set<number>;
  anchorIndex: number;
  baselineSelection: Set<number>;
}

export function applyPageSelectClick(
  state: PageSelectionState,
  index: number,
  shiftKey: boolean
): PageSelectionResult {
  if (shiftKey && state.anchorIndex !== null && state.baselineSelection) {
    const start = Math.min(state.anchorIndex, index);
    const end = Math.max(state.anchorIndex, index);

    const selected = new Set(state.baselineSelection);
    for (let i = start; i <= end; i++) {
      selected.add(i);
    }

    return {
      selected,
      anchorIndex: state.anchorIndex,
      baselineSelection: new Set(state.baselineSelection),
    };
  }

  const selected = new Set(state.selected);
  if (selected.has(index)) {
    selected.delete(index);
  } else {
    selected.add(index);
  }

  return {
    selected,
    anchorIndex: index,
    baselineSelection: new Set(selected),
  };
}
