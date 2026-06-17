import { useCallback, useMemo, useState } from "react";

/**
 * Generic checkbox-selection hook for tabular data.
 *
 * @example
 *   const sel = useSelection(filtered, (a) => a.id);
 *   <input type="checkbox" checked={sel.allSelected} ... onChange={sel.toggleAll} />
 *   <input type="checkbox" checked={sel.isSelected(row.id)} onChange={() => sel.toggle(row.id)} />
 *   <BulkActionBar count={sel.count} onDelete={() => deleteMany(sel.selectedIds)} />
 *
 * Selection is by id, so it survives reorder/sort. When the source list
 * shrinks (e.g. filtered out), `sel.selectedIds` will only return ids that
 * are still present (`selectedInList`), but the underlying set is preserved
 * so re-expanding the list restores the selection.
 */
export interface UseSelectionResult<Id> {
  /** Raw underlying set — all selected ids, including ones not in current list. */
  selectedSet: ReadonlySet<Id>;
  /** Selected ids that exist in the CURRENT list (post-filter). */
  selectedIds: Id[];
  /** Items from the current list that are selected. */
  selectedItems: readonly any[];
  /** True when every item in the current list is selected. */
  allSelected: boolean;
  /** True when some-but-not-all items are selected. */
  someSelected: boolean;
  /** Number of selected items in the current list. */
  count: number;
  /** Total selected (including out-of-list). */
  totalCount: number;
  isSelected: (id: Id) => boolean;
  toggle: (id: Id) => void;
  /** Replace selection with exactly these ids. */
  setSelected: (ids: Id[]) => void;
  /** Select all items in the current list (additive — does not clear out-of-list). */
  selectAll: () => void;
  /** Deselect all items in the current list. */
  clearList: () => void;
  /** Deselect EVERYTHING, including out-of-list ids. */
  clearAll: () => void;
  /** Toggle the "all visible" state — convenience for header checkbox. */
  toggleAll: () => void;
}

export function useSelection<T, Id = number>(
  items: readonly T[],
  getId: (item: T) => Id,
): UseSelectionResult<Id> {
  const [selectedSet, setSelectedSet] = useState<Set<Id>>(() => new Set());

  const listIds = useMemo(() => items.map(getId), [items, getId]);

  const selectedIds = useMemo(
    () => listIds.filter((id) => selectedSet.has(id)),
    [listIds, selectedSet],
  );

  const selectedItems = useMemo(
    () => items.filter((item) => selectedSet.has(getId(item))),
    [items, selectedSet, getId],
  );

  const allSelected = items.length > 0 && selectedIds.length === items.length;
  const someSelected = selectedIds.length > 0 && !allSelected;

  const isSelected = useCallback((id: Id) => selectedSet.has(id), [selectedSet]);

  const toggle = useCallback((id: Id) => {
    setSelectedSet((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const setSelected = useCallback((ids: Id[]) => {
    setSelectedSet(new Set(ids));
  }, []);

  const selectAll = useCallback(() => {
    setSelectedSet((prev) => {
      const next = new Set(prev);
      for (const id of listIds) next.add(id);
      return next;
    });
  }, [listIds]);

  const clearList = useCallback(() => {
    setSelectedSet((prev) => {
      const next = new Set(prev);
      for (const id of listIds) next.delete(id);
      return next;
    });
  }, [listIds]);

  const clearAll = useCallback(() => setSelectedSet(new Set()), []);

  const toggleAll = useCallback(() => {
    if (allSelected) clearList();
    else selectAll();
  }, [allSelected, clearList, selectAll]);

  return {
    selectedSet,
    selectedIds,
    selectedItems,
    allSelected,
    someSelected,
    count: selectedIds.length,
    totalCount: selectedSet.size,
    isSelected,
    toggle,
    setSelected,
    selectAll,
    clearList,
    clearAll,
    toggleAll,
  };
}
