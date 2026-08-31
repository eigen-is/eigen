// Active canvas tool. The shape/freehand/line tools map 1:1 to VectorElementType; `select` is the
// idle tool that hit-tests, marquees and moves; `eraser` deletes on a swipe. Lifted to the editor so
// the toolbar and the canvas share one source (the toolbar reflects/sets it, the canvas reads it +
// keyboard sets it).

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

export type VectorTool =
    | 'select'
    | 'rectangle'
    | 'diamond'
    | 'ellipse'
    | 'arrow'
    | 'line'
    | 'freedraw'
    | 'text'
    | 'eraser';

// Toolbar order (arrow slots between ellipse and line in Phase 3); letters are Excalidraw's.
// `inserts` drives the toolbar's menu split: inserting tools fill the Insert menu, the rest (the
// select mode + eraser) live in the Edit menu.
export const VECTOR_TOOLS: { tool: VectorTool; icon: LucideIcon; label: string; shortcut: string; inserts: boolean }[] =
    [
        { tool: 'select', icon: MousePointer2, label: 'Select', shortcut: 'V', inserts: false },
        { tool: 'rectangle', icon: Square, label: 'Rectangle', shortcut: 'R', inserts: true },
        { tool: 'diamond', icon: Diamond, label: 'Diamond', shortcut: 'D', inserts: true },
        { tool: 'ellipse', icon: Circle, label: 'Ellipse', shortcut: 'O', inserts: true },
        { tool: 'arrow', icon: MoveUpRight, label: 'Arrow', shortcut: 'A', inserts: true },
        { tool: 'line', icon: Minus, label: 'Line', shortcut: 'L', inserts: true },
        { tool: 'freedraw', icon: Pencil, label: 'Draw', shortcut: 'P', inserts: true },
        { tool: 'text', icon: Type, label: 'Text', shortcut: 'T', inserts: true },
        { tool: 'eraser', icon: Eraser, label: 'Eraser', shortcut: 'E', inserts: false },
    ];

export function useTool() {
    const [tool, setTool] = useState<VectorTool>('select');
    // Tool lock (Q / the toolbar padlock): when on, shape/line/arrow/text tools stay active after a
    // placement instead of reverting to select (freedraw/eraser already stay). Session-only state.
    const [toolLocked, setToolLocked] = useState(false);
    return { tool, setTool, toolLocked, setToolLocked };
}
