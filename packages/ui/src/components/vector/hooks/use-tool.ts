// The active canvas tool, lifted to the editor so the toolbar and the canvas share one source: the toolbar shows and
// sets it, the canvas reads it, and the keyboard sets it. The kind tools create the element type they name. `select`
// is the idle tool that hit-tests, marquees and moves, `text` places a text box, and `eraser` deletes on a swipe.

import type { LetterKey, NumberKey } from '@tanstack/react-hotkeys';
import type { VectorElementType } from '@workspace/lib/vector';
import { CREATION_TOOL_TYPES } from '@workspace/lib/vector';
import type { LucideIcon } from 'lucide-react';
import { Eraser, MousePointer2, Type } from 'lucide-react';
import { useState } from 'react';
import { ELEMENT_KIND_UI, TEXT_BOX_LABEL } from '../kinds';

export type VectorTool = 'select' | 'text' | 'eraser' | VectorElementType;

export type VectorToolEntry = {
    tool: VectorTool;
    icon: LucideIcon;
    label: string;
    // Absent only for a creatable kind the registry gave no shortcut: nothing is bound and nothing is
    // shown for it, rather than doubling up on Select's keys.
    shortcut?: LetterKey;
    digit?: NumberKey;
    // Splits the toolbar's menus: the inserting tools fill the Insert menu, and Select and Eraser live in the Edit menu.
    inserts: boolean;
};

// The kind tools, their order and their presentation come from the registries, so adding a kind adds a tool:
// CREATION_TOOL_TYPES is the vocabulary, ELEMENT_KIND_UI the icon, label and shortcut. A text box is a rectangle, not
// a kind, so the Text tool is listed here like Select and Eraser. useCanvasKeyboard binds both keys off this table.
export const VECTOR_TOOLS: VectorToolEntry[] = [
    { tool: 'select', icon: MousePointer2, label: 'Select', shortcut: 'V', digit: '1', inserts: false },
    ...CREATION_TOOL_TYPES.map((type) => {
        const { icon, label, shortcut } = ELEMENT_KIND_UI[type];
        return { tool: type, icon, label, shortcut: shortcut?.letter, digit: shortcut?.digit, inserts: true };
    }),
    { tool: 'text', icon: Type, label: TEXT_BOX_LABEL, shortcut: 'T', digit: '8', inserts: true },
    { tool: 'eraser', icon: Eraser, label: 'Eraser', shortcut: 'E', digit: '0', inserts: false },
];

export function useTool() {
    const [tool, setTool] = useState<VectorTool>('select');
    // The tool lock, Q or the toolbar's padlock. While it is on, a tool that places an element stays active after a
    // placement instead of going back to Select. Draw and Eraser stay active anyway. It lasts for the session only.
    const [toolLocked, setToolLocked] = useState(false);
    return { tool, setTool, toolLocked, setToolLocked };
}
