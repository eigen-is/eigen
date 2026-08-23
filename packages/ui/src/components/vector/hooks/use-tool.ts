// Active canvas tool. The three shape tools map 1:1 to VectorElementType; `select` is the
// idle tool that hit-tests, marquees and moves. Lifted to the editor so the toolbar and the
// canvas share one source (the toolbar reflects/sets it, the canvas reads it + keyboard sets it).

import { Circle, Diamond, type LucideIcon, MousePointer2, Square } from 'lucide-react';
import { useState } from 'react';

export type VectorTool = 'select' | 'rectangle' | 'diamond' | 'ellipse';

export const VECTOR_TOOLS: { tool: VectorTool; icon: LucideIcon; label: string; shortcut: string }[] = [
    { tool: 'select', icon: MousePointer2, label: 'Select', shortcut: 'V' },
    { tool: 'rectangle', icon: Square, label: 'Rectangle', shortcut: 'R' },
    { tool: 'diamond', icon: Diamond, label: 'Diamond', shortcut: 'D' },
    { tool: 'ellipse', icon: Circle, label: 'Ellipse', shortcut: 'O' },
];

export function useTool() {
    const [tool, setTool] = useState<VectorTool>('select');
    return { tool, setTool };
}
