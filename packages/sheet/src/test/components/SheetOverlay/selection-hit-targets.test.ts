// Pins the selection's invisible hit targets, which are pure CSS geometry and
// therefore impossible to see in a screenshot and easy to shrink by accident.
// Everything here is read off index.css and reduced to one number per edge: how
// far the grab area reaches outside the selection (over a neighbouring cell) and
// how far it reaches inside it (over the selection's own interior, which is what
// a plain click uses to start a new selection).

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const css = readFileSync(fileURLToPath(new URL('../../../components/SheetOverlay/index.css', import.meta.url)), 'utf8');

function declarations(selector: string): Map<string, string> {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(`^${escaped}\\s*\\{([^}]*)\\}`, 'm').exec(css);
    if (match == null) throw new Error(`no rule for ${selector}`);
    const decls = new Map<string, string>();
    for (const decl of match[1].split(';')) {
        const colon = decl.indexOf(':');
        if (colon === -1) continue;
        decls.set(decl.slice(0, colon).trim(), decl.slice(colon + 1).trim());
    }
    return decls;
}

function px(selector: string, property: string): number {
    const value = declarations(selector).get(property);
    if (value == null) throw new Error(`${selector} has no ${property}`);
    return Number.parseFloat(value);
}

// Selection padding-box edge = 0, outside positive. `offset` is the CSS offset on
// that edge (top/right/bottom/left), `size` the box's extent across it.
function reach(offset: number, size: number) {
    return { outside: -offset, inside: offset + size };
}

// The four strips, each read on the edge it hugs.
const strips = [
    { selector: '.sheet-cs-draghandle-top', offset: 'top', size: 'height' },
    { selector: '.sheet-cs-draghandle-bottom', offset: 'bottom', size: 'height' },
    { selector: '.sheet-cs-draghandle-left', offset: 'left', size: 'width' },
    { selector: '.sheet-cs-draghandle-right', offset: 'right', size: 'width' },
] as const;

describe('drag-to-move band', () => {
    test('is 8px centred on the selection border, on all four edges', () => {
        for (const { selector, offset, size } of strips) {
            expect(reach(px(selector, offset), px(selector, size))).toEqual({ outside: 4, inside: 4 });
        }
    });

    test('never reaches more than 4px over a neighbouring cell', () => {
        // 4px is the fork's original outward offset. Growing it is what starts
        // swallowing clicks meant for the cell next to the selection.
        for (const { selector, offset } of strips) {
            expect(-px(selector, offset)).toBeLessThanOrEqual(4);
        }
    });

    test('leaves the middle of a default 19px row free to start a new selection', () => {
        const top = reach(px('.sheet-cs-draghandle-top', 'top'), px('.sheet-cs-draghandle-top', 'height'));
        const bottom = reach(px('.sheet-cs-draghandle-bottom', 'bottom'), px('.sheet-cs-draghandle-bottom', 'height'));
        expect(19 - top.inside - bottom.inside).toBeGreaterThan(8);
    });

    test('paints nothing — it is hit area only', () => {
        const decls = declarations('.sheet-cs-draghandle');
        expect(decls.get('background-color')).toBeUndefined();
        expect(decls.get('opacity')).toBeUndefined();
        expect(decls.get('border')).toBeUndefined();
    });
});

describe('fill handle', () => {
    test('the visible square is unchanged: 6px, 5px past the corner', () => {
        for (const property of ['width', 'height']) {
            expect(px('.sheet-cs-fillhandle', property)).toBe(6);
        }
        for (const property of ['bottom', 'right']) {
            expect(px('.sheet-cs-fillhandle', property)).toBe(-5);
        }
    });

    test('the hit target is 14px and centred on the selection corner, not on the square', () => {
        const inset = declarations('.sheet-cs-fillhandle::after').get('inset');
        if (inset == null) throw new Error('no inset on .sheet-cs-fillhandle::after');
        const [insetTop, insetRight, insetBottom, insetLeft] = inset.split(/\s+/).map(Number.parseFloat);
        // Axis points outward from the selection's corner. The pseudo-element's
        // insets are measured from the handle's padding box, so the handle's own
        // border sits between them and the square the user sees.
        const border = Number.parseFloat(
            /(-?[\d.]+)px/.exec(declarations('.sheet-cs-fillhandle').get('border') ?? '')?.[1] ?? '',
        );
        const squareOuterEdge = -px('.sheet-cs-fillhandle', 'bottom');
        const squareInnerEdge = squareOuterEdge - px('.sheet-cs-fillhandle', 'height');

        const outside = squareOuterEdge - border - insetBottom;
        const inside = -(squareInnerEdge + border + insetTop);
        expect({ outside, inside }).toEqual({ outside: 6, inside: 8 });
        expect(outside + inside).toBe(14);
        // Same geometry on the horizontal axis.
        expect(insetLeft).toBe(insetTop);
        expect(insetRight).toBe(insetBottom);
    });

    test('beats the move band at the bottom-right corner', () => {
        expect(px('.sheet-cs-fillhandle', 'z-index')).toBeGreaterThan(px('.sheet-cs-draghandle', 'z-index'));
    });
});

test('both handles opt back into hit-testing', () => {
    // The OverlayRegion wrapper is pointer-events none and the property inherits,
    // so an interactive overlay child that forgets this is silently unclickable.
    expect(declarations('.sheet-cs-fillhandle').get('pointer-events')).toBe('auto');
    expect(declarations('.sheet-cs-draghandle').get('pointer-events')).toBe('auto');
});
