// Pins the selection's invisible hit targets, which are pure CSS geometry and
// therefore impossible to see in a screenshot and easy to shrink by accident.
// The two sizes are named once on .sheet-overlay and every offset derives from
// them with calc(), so this reads the named values rather than re-deriving a
// private model of the box model that could be wrong in the same way the CSS is.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Comments stripped first: a `:` inside one would otherwise be read as a declaration.
const css = readFileSync(
    fileURLToPath(new URL('../../../components/SheetOverlay/index.css', import.meta.url)),
    'utf8',
).replace(/\/\*[\s\S]*?\*\//g, '');

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

const GRAB_BAND = px('.sheet-overlay', '--sheet-grab-band');
const FILL_GRAB = px('.sheet-overlay', '--sheet-fill-grab');

describe('drag-to-move band', () => {
    test('is 8px, centred on the selection border by a calc off the named value', () => {
        expect(GRAB_BAND).toBe(8);
        expect(declarations('.sheet-cs-draghandle').get('--sheet-grab-band-offset')).toBe(
            'calc(var(--sheet-grab-band) / -2)',
        );
        for (const selector of ['top', 'bottom', 'left', 'right'].map((edge) => `.sheet-cs-draghandle-${edge}`)) {
            for (const [, value] of declarations(selector)) {
                expect(value).toMatch(/var\(--sheet-grab-band(-offset)?\)/);
            }
        }
    });

    test('never reaches more than 4px over a neighbouring cell', () => {
        // 4px is the fork's original outward offset. Growing it is what starts
        // swallowing clicks meant for the cell next to the selection.
        expect(GRAB_BAND / 2).toBeLessThanOrEqual(4);
    });

    test('leaves the middle of a default 19px row free to start a new selection', () => {
        // Both the top and the bottom band eat half their width from the row's interior.
        expect(19 - GRAB_BAND).toBeGreaterThan(8);
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

    test('the grab area is 14px, spent off the named value on both axes', () => {
        expect(FILL_GRAB).toBe(14);
        const decls = declarations('.sheet-cs-fillhandle::after');
        expect(decls.get('--sheet-fill-grab-inner')).toBe('calc(6px - var(--sheet-fill-grab))');
        // The inward inset carries the calc on both axes; the outward pair is the 2px
        // that puts the grab 1px past the square, which the rule's comment explains.
        expect(decls.get('inset')).toBe('var(--sheet-fill-grab-inner) -2px -2px var(--sheet-fill-grab-inner)');
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
