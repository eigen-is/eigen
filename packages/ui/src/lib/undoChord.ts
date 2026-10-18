// ⌘Z or Ctrl+Z is undo; ⇧⌘Z, ⇧Ctrl+Z or Ctrl+Y is redo. For a field outside the editor that hands the key to the
// document's history instead of the browser's own field undo.
export function undoChord(e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey'>): 'undo' | 'redo' | null {
    if (!(e.metaKey || e.ctrlKey)) return null;
    if (e.key === 'z' || e.key === 'Z') return e.shiftKey ? 'redo' : 'undo';
    if (e.key === 'y' || e.key === 'Y') return 'redo';
    return null;
}
