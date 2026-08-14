/**
 * While dragging one of several selected pages, SortableJS's live reorder
 * preview treats every page it hovers over as a potential drop point --
 * including the other selected pages, which are mid-flight/invisible (see
 * the multi-drag fly-in animation) and would otherwise cause the preview
 * to jitter between every gap they leave behind. This restricts valid
 * live-preview snap points to only the first or last page of each
 * contiguous run of selected pages, e.g. for a selection of {3..10, 12..15}
 * only indices 3, 10, 12, and 15 are valid snap points.
 */
export function isSelectionDragSnapPoint(
  selectedIndices: ReadonlySet<number>,
  index: number
): boolean {
  if (!selectedIndices.has(index)) {
    return true;
  }
  return !selectedIndices.has(index - 1) || !selectedIndices.has(index + 1);
}
