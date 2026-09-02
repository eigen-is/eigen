import type * as Y from 'yjs';
import type { SlideObject } from './types';

// The one canonical stored-key registry for a slide object's per-object Y.Map. Every
// doc.transact write iterates it and the reader materializes only these keys — shared by the
// FE (use-deck) and the BE (document/slides) so the two can never drift (the "two lists of one
// fact" AGENTS.md warns about). Geometry uses the canonical names width/height/angle.
export const OBJECT_FIELDS = [
    'id',
    'slideId',
    'type',
    'x',
    'y',
    'width',
    'height',
    'angle',
    'borderColor',
    'borderWidth',
    'borderRadius',
    'text',
    'fontFamily',
    'fontSize',
    'fontWeight',
    'fontStyle',
    'textDecoration',
    'textAlign',
    'verticalAlign',
    'color',
    'letterSpacing',
    'lineHeight',
    'highlightColor',
    'background',
    'mediaName',
    'objectFit',
    'commentCardIds',
] as const;

// Materialize a per-object Y.Map into a plain SlideObject over the whitelist. commentCardIds is
// always normalized to a string[] — it has only ever been stored as a plain array.
export function yMapToObject(yMap: Y.Map<unknown>): SlideObject {
    const obj: Record<string, unknown> = {};
    for (const field of OBJECT_FIELDS) {
        const val = yMap.get(field);
        if (val !== undefined) obj[field] = val;
    }
    const raw = obj['commentCardIds'];
    obj['commentCardIds'] = Array.isArray(raw) ? raw : [];
    return obj as SlideObject;
}
