// Active canvas tool. The shape/freehand/line tools map 1:1 to VectorElementType; `select` is the
// idle tool that hit-tests, marquees and moves; `eraser` deletes on a swipe. Lifted to the editor so
// the toolbar and the canvas share one source (the toolbar reflects/sets it, the canvas reads it +
// keyboard sets it).

import { Circle, Diamond, Eraser, type LucideIcon, Minus, MousePointer2, Pencil, Square, Type } from 'lucide-react';
import { useState } from 'react';

export type VectorTool = 'select' | 'rectangle' | 'diamond' | 'ellipse' | 'line' | 'freedraw' | 'text' | 'eraser';

// Toolbar order (arrow slots between ellipse and line in Phase 3); letters are Excalidraw's.
export const VECTOR_TOOLS: { tool: VectorTool; icon: LucideIcon; label: string; shortcut: string }[] = [
    { tool: 'select', icon: MousePointer2, label: 'Select', shortcut: 'V' },
    { tool: 'rectangle', icon: Square, label: 'Rectangle', shortcut: 'R' },
    { tool: 'diamond', icon: Diamond, label: 'Diamond', shortcut: 'D' },
    { tool: 'ellipse', icon: Circle, label: 'Ellipse', shortcut: 'O' },
    { tool: 'line', icon: Minus, label: 'Line', shortcut: 'L' },
    { tool: 'freedraw', icon: Pencil, label: 'Draw', shortcut: 'P' },
    { tool: 'text', icon: Type, label: 'Text', shortcut: 'T' },
    { tool: 'eraser', icon: Eraser, label: 'Eraser', shortcut: 'E' },
];

export function useTool() {
    const [tool, setTool] = useState<VectorTool>('select');
    return { tool, setTool };
}
