import type { Cell } from '@workspace/lib/sheets';

// Cell-style facts both Sheet[] emitters read: the HTML/PDF renderer (render.ts) and the
// XLSX writer (to-xlsx.ts). They live here rather than in either emitter because to-xlsx
// must not import render.ts — that would pull DOMPurify/jsdom (via sanitize) into the
// xlsx path, which transform.ts deliberately loads separately.

export const HORIZONTAL_ALIGN: Record<number, 'left' | 'center' | 'right'> = {
    0: 'center',
    1: 'left',
    2: 'right',
};

export const VERTICAL_ALIGN: Record<number, 'top' | 'middle' | 'bottom'> = {
    0: 'middle',
    1: 'top',
    2: 'bottom',
};

// `rt` is schemaless and also carries the non-numeric 'vertical' writing mode, so a real
// rotation is only a number inside Excel's ±90 range.
export function isNumericRotation(v: Cell | null): v is Cell & { rt: number } {
    return !!v && typeof v.rt === 'number' && v.rt !== 0 && v.rt >= -90 && v.rt <= 90;
}
