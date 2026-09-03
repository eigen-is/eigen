// Active canvas tool. The shape/freehand/line tools map 1:1 to VectorElementType; `select` is the
// idle tool that hit-tests, marquees and moves; `eraser` deletes on a swipe. Lifted to the editor so
// the toolbar and the canvas share one source (the toolbar reflects/sets it, the canvas reads it +
// keyboard sets it).

import { CREATION_TOOL_TYPES, type CreationToolType, type VectorElementType } from '@workspace/lib/vector';
import {
    Circle,
    Diamond,
    Eraser,
    type LucideIcon,
    Minus,
    MousePointer2,
    MoveUpRight,
    Pencil,
    Square,
    Type,
} from 'lucide-react';
import { useState } from 'react';

export type VectorTool = 'select' | 'eraser' | VectorElementType;

// Presentation only; the LIST and its ORDER come from the registry, so adding a kind adds a tool.
// Keying by CreationToolType is what makes TypeScript demand an entry per creatable kind (and reject
// one for image, which arrives by upload). Letters are Excalidraw's.
const TOOL_UI: Record<CreationToolType, { icon: LucideIcon; label: string; shortcut: string }> = {
    rectangle: { icon: Square, label: 'Rectangle', shortcut: 'R' },
    diamond: { icon: Diamond, label: 'Diamond', shortcut: 'D' },
    ellipse: { icon: Circle, label: 'Ellipse', shortcut: 'O' },
    arrow: { icon: MoveUpRight, label: 'Arrow', shortcut: 'A' },
    line: { icon: Minus, label: 'Line', shortcut: 'L' },
    freedraw: { icon: Pencil, label: 'Draw', shortcut: 'P' },
    richtext: { icon: Type, label: 'Text', shortcut: 'T' },
};

// `inserts` drives the toolbar's menu split: inserting tools fill the Insert menu, the rest (the
// select mode + eraser) live in the Edit menu.
export const VECTOR_TOOLS: { tool: VectorTool; icon: LucideIcon; label: string; shortcut: string; inserts: boolean }[] =
    [
        { tool: 'select', icon: MousePointer2, label: 'Select', shortcut: 'V', inserts: false },
        ...CREATION_TOOL_TYPES.map((type) => ({ tool: type, ...TOOL_UI[type], inserts: true })),
        { tool: 'eraser', icon: Eraser, label: 'Eraser', shortcut: 'E', inserts: false },
    ];

export function useTool() {
    const [tool, setTool] = useState<VectorTool>('select');
    // Tool lock (Q / the toolbar padlock): when on, shape/line/arrow/text tools stay active after a
    // placement instead of reverting to select (freedraw/eraser already stay). Session-only state.
    const [toolLocked, setToolLocked] = useState(false);
    return { tool, setTool, toolLocked, setToolLocked };
}
