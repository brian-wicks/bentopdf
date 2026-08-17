/**
 * Windows-Explorer-style click/shift-click/ctrl-click selection.
 *
 * Shift+click recomputes the selection from a baseline snapshot taken when
 * the anchor was set, plus the anchor..target range — so extending the
 * range grows the selection, and pulling it back in deselects pages that
 * fall back out. Otherwise, behavior depends on `mode`: 'toggle' adds or
 * removes just the target page (e.g. the selection checkbox, or a
 * ctrl/cmd-click); 'exclusive' replaces the whole selection with just the
 * target page (a plain click on the page itself). Either way, the clicked
 * page becomes the new anchor.
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

export type PageSelectClickMode = 'toggle' | 'exclusive';

export function applyPageSelectClick(
  state: PageSelectionState,
  index: number,
  shiftKey: boolean,
  mode: PageSelectClickMode = 'toggle'
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

  if (mode === 'exclusive') {
    const selected = new Set([index]);
    return {
      selected,
      anchorIndex: index,
      baselineSelection: new Set(selected),
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
