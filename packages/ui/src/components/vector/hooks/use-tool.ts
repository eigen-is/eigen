// Active canvas tool. The shape/freehand/line tools map 1:1 to VectorElementType; `select` is the
// idle tool that hit-tests, marquees and moves; `eraser` deletes on a swipe. Lifted to the editor so
// the toolbar and the canvas share one source (the toolbar reflects/sets it, the canvas reads it +
// keyboard sets it).

import type { LetterKey, NumberKey } from '@tanstack/react-hotkeys';
import { CREATION_TOOL_TYPES, type VectorElementType } from '@workspace/lib/vector';
import { Eraser, type LucideIcon, MousePointer2 } from 'lucide-react';
import { useState } from 'react';
import { ELEMENT_KIND_UI } from '../kinds';

export type VectorTool = 'select' | 'eraser' | VectorElementType;

export type VectorToolEntry = {
    tool: VectorTool;
    icon: LucideIcon;
    label: string;
    shortcut: LetterKey;
    digit: NumberKey;
    // Drives the toolbar's menu split: inserting tools fill the Insert menu, the rest (the select mode
    // + eraser) live in the Edit menu.
    inserts: boolean;
};

// A creatable kind without a shortcut is a registry bug, not a runtime state (the registry test pins
// it); this keeps the type honest without inventing a second table or a cast.
const NO_SHORTCUT: { letter: LetterKey; digit: NumberKey } = { letter: 'V', digit: '1' };

// The LIST, its ORDER and its presentation come from the registries, so adding a kind adds a tool:
// CREATION_TOOL_TYPES is the vocabulary, ELEMENT_KIND_UI the icon/label/shortcut. useCanvasKeyboard
// binds both keys straight off this table.
export const VECTOR_TOOLS: VectorToolEntry[] = [
    { tool: 'select', icon: MousePointer2, label: 'Select', shortcut: 'V', digit: '1', inserts: false },
    ...CREATION_TOOL_TYPES.map((type) => {
        const { icon, label, shortcut = NO_SHORTCUT } = ELEMENT_KIND_UI[type];
        return { tool: type, icon, label, shortcut: shortcut.letter, digit: shortcut.digit, inserts: true };
    }),
    { tool: 'eraser', icon: Eraser, label: 'Eraser', shortcut: 'E', digit: '0', inserts: false },
];

export function useTool() {
    const [tool, setTool] = useState<VectorTool>('select');
    // Tool lock (Q / the toolbar padlock): when on, shape/line/arrow/text tools stay active after a
    // placement instead of reverting to select (freedraw/eraser already stay). Session-only state.
    const [toolLocked, setToolLocked] = useState(false);
    return { tool, setTool, toolLocked, setToolLocked };
}
