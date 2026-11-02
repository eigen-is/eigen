// Keys that a binding and the menu row naming it share, such as the undo and redo keys of every editor or the
// keys of a Drive listing. Each is spelled as @tanstack/react-hotkeys spells it, and a menu draws it through
// formatForDisplay, which shows Mod as ⌘ on a Mac and as Ctrl elsewhere.

export const UNDO_HOTKEY = 'Mod+Z';
export const REDO_HOTKEY = 'Mod+Shift+Z';
// The redo key Windows apps use, which every editor takes too.
export const REDO_ALT_HOTKEY = 'Mod+Y';

// A Drive listing previews the selected file on Space and trashes it on Backspace. Delete trashes too, but
// the menu names Backspace, as Finder does.
export const QUICK_LOOK_HOTKEY = 'Space';
export const DELETE_HOTKEY = 'Backspace';
