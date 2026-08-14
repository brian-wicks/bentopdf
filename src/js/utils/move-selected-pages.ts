/**
 * Reorders a list for a drag-and-drop move, carrying every other selected
 * item along with the one actually dragged (when the drag started on a
 * multi-page selection) so the whole selection moves as one block while
 * preserving each item's relative order within that block.
 *
 * `draggedIndex` / `targetIndex` use plain single-item splice semantics
 * (the same indices a drag library like SortableJS reports): removing the
 * dragged item leaves an (n-1)-length list, and `targetIndex` is where it
 * would land back in that list.
 */

export interface MoveSelectedPagesResult<T> {
  items: T[];
  selectedIndices: Set<number>;
}

export function moveSelectedPages<T>(
  items: readonly T[],
  selectedIndices: ReadonlySet<number>,
  draggedIndex: number,
  targetIndex: number
): MoveSelectedPagesResult<T> {
  const isGroupMove =
    selectedIndices.has(draggedIndex) && selectedIndices.size > 1;
  const group = isGroupMove
    ? [...selectedIndices].sort((a, b) => a - b)
    : [draggedIndex];
  const groupSet = new Set(group);

  const reducedIndices: number[] = [];
  items.forEach((_, i) => {
    if (i !== draggedIndex) reducedIndices.push(i);
  });

  let insertionPoint = 0;
  for (let p = 0; p < targetIndex; p++) {
    if (!groupSet.has(reducedIndices[p])) insertionPoint++;
  }

  const remainingIndices: number[] = [];
  items.forEach((_, i) => {
    if (!groupSet.has(i)) remainingIndices.push(i);
  });

  const finalIndices = [
    ...remainingIndices.slice(0, insertionPoint),
    ...group,
    ...remainingIndices.slice(insertionPoint),
  ];

  const newSelectedIndices = new Set<number>();
  const newItems = finalIndices.map((originalIndex, position) => {
    if (selectedIndices.has(originalIndex)) {
      newSelectedIndices.add(position);
    }
    return items[originalIndex];
  });

  return { items: newItems, selectedIndices: newSelectedIndices };
}
