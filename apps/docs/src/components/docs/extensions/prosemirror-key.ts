// A shared hotkey in the spelling a Tiptap extension's keyboard shortcuts take, so a docs extension binds the key its
// menu row shows, such as Insert › Comment's or Insert › Footnote's.

import type { Hotkey } from '@tanstack/react-hotkeys';

// ProseMirror spells a key with dashes and a letter in lower case, which a capital would read as Shift.
export const proseMirrorKey = (hotkey: Hotkey): string => hotkey.replaceAll('+', '-').toLowerCase();
