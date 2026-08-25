// Characterization tests for the HTML-table paste branch (SHEETS-TODO group 4).
// handlePaste's `txtdata.indexOf('table') > -1` arm builds a real DOM
// (document.createElement('div').innerHTML + querySelectorAll + td.style/innerText +
// CSSOM border decomposition + <style> class-block parsing), turns each <td> into a
// Cell, then hands the parsed CellMatrix + per-cell border map to the non-exported
// pasteHandler CellMatrix arm (paste.ts ~157-283 — the third copy of the
// offsetMC/merge remap). Bun's runtime has no DOM, so this file installs a real
// happy-dom document at module scope and drives handlePaste with a structurally
// stubbed ClipboardEvent. Tests pin observable output in the resulting Context
// (cell values/ct/styles, cfg.merge, cfg.borderInfo, cfg.rowlen, selections) so the
// upcoming refactors near the paste pipeline are gated on current behaviour. They
// never assert on internal call sequences.

import { describe, expect, it } from 'bun:test';
import type { CellBorderInfo } from '@workspace/lib/sheets';
import { Window } from 'happy-dom';
import type { Cell } from '../../../engine/types';
import type { Context } from '../../../state/context';
import { handlePaste } from '../../../state/events/paste';
import { selectionCache } from '../../../state/modules/selection';
import { contextFactory } from '../factories/context';
import { pastedHtmlFactory } from '../factories/pasted-html';

// The branch reads the *global* `document` (not a passed-in window). Install a real
// happy-dom document at module scope so querySelectorAll / td.style / innerText /
// border CSSOM all resolve. This file is the only sheet test that needs a full DOM;
// the DOM-free siblings (paste.test.ts, clipboard-cut.test.ts, …) each overwrite
// g.document with their own stub at their own module scope, so ordering stays safe —
// proven by the full suite staying green. Not @happy-dom/global-registrator, which
// would leak DOM globals across the whole sheet test process.
// biome-ignore lint/suspicious/noExplicitAny: test-only globalThis injection
const g = globalThis as any;
g.document = new Window().document;
g.sessionStorage = { setItem: () => {} };

function grid(rows: number, cols: number): (Cell | null)[][] {
    return Array.from({ length: rows }, () => Array.from({ length: cols }, () => null));
}

function single(r: number, c: number) {
    return [{ row: [r, r], column: [c, c], row_focus: r, column_focus: c }];
}

// A single-sheet ctx with an explicit rows x cols grid, selection anchored at (0,0).
function makeCtx(rows = 8, cols = 8): Context {
    return contextFactory({
        currentSheetId: 'id_1',
        selections: single(0, 0),
        sheets: [{ name: 'sheet', id: 'id_1', order: 0, data: grid(rows, cols) }],
    }) as Context;
}

// Structural ClipboardEvent stub: the branch only ever calls
// clipboardData.getData('text/html') (falling back to 'text/plain') and, on other
// arms, reads clipboardData.files — neither of which bun provides.
function fakeClipboardEvent(html: string): ClipboardEvent {
    return {
        clipboardData: { getData: (type: string) => (type === 'text/html' ? html : ''), files: [] },
    } as unknown as ClipboardEvent;
}

// handlePaste no-ops unless a paste action is in flight (selectionCache.isPasteAction),
// mirroring the real keydown → paste sequence.
function pasteHtml(ctx: Context, html: string) {
    selectionCache.isPasteAction = true;
    handlePaste(ctx, fakeClipboardEvent(html));
}

// Real Excel clipboards indent every property line of the <style> block with a TAB;
// the branch's class-block parser (nameReg = /^[^\t].*/gm) depends on that so the
// selector lines are the only non-tab lines. The committed Excel/WPS fixtures are
// space-indented, so their class block does NOT parse (allStyleList = {}); this
// hand-written table reproduces the tab-indented pattern to exercise the working
// class-block path. See the fidelity note in task-A-report.md.
const excelClassBlockHtml = `<html><head><style>
<!--table
\t{color:black;}
td
\t{color:black;font-weight:400;}
.xl65
\t{font-weight:700;}
.xl66
\t{color:#ED7D31;}
.xl67
\t{background:#ED7D31;}
.xl68
\t{text-decoration:underline;}
.xl69
\t{font-style:italic;}
-->
</style></head><body>
<table>
<tr><td class=xl65>2</td><td class=xl66>3</td></tr>
<tr><td class=xl67>4</td><td class=xl68>5</td></tr>
<tr><td class=xl69>6</td><td>7</td></tr>
</table></body></html>`;

describe('HTML-table paste — values and selection', () => {
    it('lands numeric cells as numbers and expands the selection to the pasted rectangle (Excel fixture)', () => {
        const ctx = makeCtx();
        pasteHtml(ctx, pastedHtmlFactory('Excel'));

        const d = ctx.sheets[0].data!;
        // genarate() masks the plain integers to numeric cells (ct.t === 'n')
        expect(d[0][0]?.v).toBe(1);
        expect(d[0][0]?.ct?.t).toBe('n');
        expect(d[0][1]?.v).toBe(2);
        expect(d[0][2]?.v).toBe(3);
        expect(d[1][0]?.v).toBe(3);
        expect(d[2][0]?.v).toBe(4);
        expect(d[3][0]?.v).toBe(5);
        // 4 rows x 3 cols pasted at anchor (0,0)
        expect(ctx.selections![0].row).toEqual([0, 3]);
        expect(ctx.selections![0].column).toEqual([0, 2]);
    });

    it('pastes at a non-origin anchor, offsetting every cell and the selection (WPS fixture at (2,2))', () => {
        const ctx = makeCtx();
        ctx.selections = single(2, 2);
        pasteHtml(ctx, pastedHtmlFactory('WPS'));

        const d = ctx.sheets[0].data!;
        expect(d[2][2]?.v).toBe(1);
        expect(d[2][3]?.bl).toBe(1); // bold '2' shifted
        expect(d[3][2]?.bg).toBe('#ED7D31'); // background '4' shifted
        expect(d[5][2]?.it).toBe(1); // italic '6' shifted
        expect(d[0][0]).toBeNull();
        expect(ctx.selections![0].row).toEqual([2, 5]);
        expect(ctx.selections![0].column).toEqual([2, 4]);
    });

    it('expands the grid when the pasted table is bigger than the remaining sheet', () => {
        const ctx = makeCtx(2, 2);
        pasteHtml(
            ctx,
            '<table>' +
                '<tr><td>a</td><td>b</td><td>c</td></tr>' +
                '<tr><td>d</td><td>e</td><td>f</td></tr>' +
                '<tr><td>g</td><td>h</td><td>i</td></tr>' +
                '</table>',
        );

        const d = ctx.sheets[0].data!;
        expect(d.length).toBe(3);
        expect(d[0].length).toBe(3);
        expect(d[0][0]?.v).toBe('a');
        expect(d[2][2]?.v).toBe('i');
        expect(ctx.selections![0].row).toEqual([0, 2]);
        expect(ctx.selections![0].column).toEqual([0, 2]);
    });
});

describe('HTML-table paste — style extraction', () => {
    it('reads bold / font-color / background / underline / italic from the <style> class block', () => {
        const ctx = makeCtx();
        pasteHtml(ctx, excelClassBlockHtml);

        const d = ctx.sheets[0].data!;
        // values confirm the table itself parsed
        expect(d[0][0]?.v).toBe(2);
        expect(d[2][1]?.v).toBe(7);
        // styles come from the .xl6x class rules
        expect(d[0][0]?.bl).toBe(1); // .xl65 font-weight:700
        expect(d[0][1]?.fc).toBe('#ED7D31'); // .xl66 color
        expect(d[1][0]?.bg).toBe('#ED7D31'); // .xl67 background
        expect(d[1][1]?.un).toBe(1); // .xl68 text-decoration:underline
        expect(d[2][0]?.it).toBe(1); // .xl69 font-style:italic
    });

    it('reads bold / font-color / background / italic from inline td.style (WPS fixture)', () => {
        const ctx = makeCtx();
        pasteHtml(ctx, pastedHtmlFactory('WPS'));

        const d = ctx.sheets[0].data!;
        expect(d[0][1]?.bl).toBe(1); // font-weight:700
        expect(d[0][2]?.bl).toBe(1);
        expect(d[0][2]?.fc).toBe('#ED7D31'); // color
        expect(d[1][0]?.bg).toBe('#ED7D31'); // background
        expect(d[3][0]?.it).toBe(1); // font-style:italic

        // Characterized gap: inline `text-decoration:underline` is NOT read from
        // td.style — the branch only picks up underline from the <style> class block
        // (see the class-block test above). A WPS-underlined cell therefore loses its
        // underline. Pinned so a refactor that changes this is a conscious decision.
        expect(d[2][0]?.un).toBeUndefined();
    });

    it('sets cl=1 for a <s> strikethrough inside the td', () => {
        const ctx = makeCtx();
        pasteHtml(ctx, '<table><tr><td><s>x</s></td></tr></table>');

        expect(ctx.sheets[0].data![0][0]?.cl).toBe(1);
    });

    it('maps text-align to ht (right=2/center=0/left=1) and vertical-align to vt (middle=0/top=1/bottom=2)', () => {
        const ctx = makeCtx();
        pasteHtml(
            ctx,
            '<table><tr>' +
                '<td style="text-align:right;vertical-align:middle">r</td>' +
                '<td style="text-align:center;vertical-align:top">c</td>' +
                '<td style="text-align:left;vertical-align:bottom">l</td>' +
                '</tr></table>',
        );

        const d = ctx.sheets[0].data!;
        expect(d[0][0]?.ht).toBe(2);
        expect(d[0][0]?.vt).toBe(0);
        expect(d[0][1]?.ht).toBe(0);
        expect(d[0][1]?.vt).toBe(1);
        expect(d[0][2]?.ht).toBe(1);
        expect(d[0][2]?.vt).toBe(2);
    });
});

describe('HTML-table paste — merges, borders, row height', () => {
    it('turns a rowspan=2 colspan=2 td into one merge entry, an anchor mc, and offsetMC-filled covered cells', () => {
        const ctx = makeCtx();
        pasteHtml(ctx, '<table><tr><td rowspan=2 colspan=2>M</td><td>b</td></tr><tr><td>c</td></tr></table>');

        const d = ctx.sheets[0].data!;
        expect(d[0][0]?.v).toBe('M');
        expect(d[0][0]?.mc).toEqual({ r: 0, c: 0, rs: 2, cs: 2 });
        // the three covered cells point back at the anchor via the offsetMC remap
        expect(d[0][1]?.mc).toEqual({ r: 0, c: 0 });
        expect(d[1][0]?.mc).toEqual({ r: 0, c: 0 });
        expect(d[1][1]?.mc).toEqual({ r: 0, c: 0 });
        // the second-row td flows past the merged span into column 2
        expect(d[0][2]?.v).toBe('b');
        expect(d[1][2]?.v).toBe('c');
        expect(ctx.sheets[0].config!.merge).toEqual({ '0_0': { r: 0, c: 0, rs: 2, cs: 2 } });
    });

    it('decomposes an inline td border into a cfg.borderInfo cell entry via getQKBorder', () => {
        const ctx = makeCtx();
        pasteHtml(ctx, '<table><tr><td style="border:1px solid #0000ff">B</td></tr></table>');

        const pushed = ctx.sheets[0].config!.borderInfo!.find(
            (e) => e.rangeType === 'cell' && e.value.row_index === 0 && e.value.col_index === 0,
        );
        // 1px solid -> getQKBorder style 1; colour passes through verbatim
        expect(pushed).toEqual({
            rangeType: 'cell',
            value: {
                row_index: 0,
                col_index: 0,
                l: { style: 1, color: '#0000ff' },
                r: { style: 1, color: '#0000ff' },
                t: { style: 1, color: '#0000ff' },
                b: { style: 1, color: '#0000ff' },
            },
        });
    });

    it('keys merges and borders correctly at a non-origin anchor (absolute vs relative coordinates)', () => {
        // cfg.merge/mc use absolute coordinates while the borderInfo lookup is
        // relative (`${h - minh}_${c - minc}`); at anchor (0,0) the two coincide,
        // so only a shifted anchor can catch a refactor that mixes them up.
        const ctx = makeCtx();
        ctx.selections = single(3, 2);
        pasteHtml(
            ctx,
            '<table><tr><td rowspan=2 colspan=2 style="border:1px solid #0000ff">M</td><td>b</td></tr><tr><td>c</td></tr></table>',
        );

        const d = ctx.sheets[0].data!;
        expect(d[3][2]?.v).toBe('M');
        expect(d[3][2]?.mc).toEqual({ r: 3, c: 2, rs: 2, cs: 2 });
        expect(d[3][3]?.mc).toEqual({ r: 3, c: 2 });
        expect(d[4][2]?.mc).toEqual({ r: 3, c: 2 });
        expect(d[4][3]?.mc).toEqual({ r: 3, c: 2 });
        expect(d[3][4]?.v).toBe('b');
        expect(d[4][4]?.v).toBe('c');
        expect(ctx.sheets[0].config!.merge).toEqual({ '3_2': { r: 3, c: 2, rs: 2, cs: 2 } });

        // outer edges of the merged 2x2 block, at absolute row/col indices
        const side = { style: 1, color: '#0000ff' };
        const entry = (r: number, c: number) =>
            ctx.sheets[0].config!.borderInfo!.find(
                (e): e is CellBorderInfo =>
                    e.rangeType === 'cell' && e.value.row_index === r && e.value.col_index === c,
            );
        expect(entry(3, 2)?.value.t).toEqual(side);
        expect(entry(3, 2)?.value.l).toEqual(side);
        expect(entry(3, 2)?.value.b).toBeUndefined();
        expect(entry(4, 3)?.value.b).toEqual(side);
        expect(entry(4, 3)?.value.r).toEqual(side);
        expect(entry(4, 3)?.value.t).toBeUndefined();
    });

    it('writes a tr height attribute into cfg.rowlen at the target row', () => {
        const ctx = makeCtx();
        ctx.selections = single(2, 1);
        pasteHtml(ctx, '<table><tr height=30><td>a</td></tr></table>');

        expect(ctx.sheets[0].config!.rowlen![2]).toBe(30);
        expect(ctx.sheets[0].data![2][1]?.v).toBe('a');
    });

    it('refuses a paste that would partially cover an existing merge (hasPartMC guard)', () => {
        const ctx = makeCtx(6, 6);
        ctx.config = { merge: { '0_0': { r: 0, c: 0, rs: 2, cs: 2 } } };
        // In the live app ctx.config aliases the current sheet's config
        // (storeSheetParamALL). Mirror that: the branch's setRowHeight reassigns
        // ctx.config = sheet.config, so without the alias the merge would be orphaned
        // before hasPartMC runs and the guard would spuriously pass.
        ctx.sheets[0].config = ctx.config;
        // paste a 2x1 table starting inside the merge and crossing its bottom edge
        ctx.selections = single(1, 0);
        pasteHtml(ctx, '<table><tr><td>9</td></tr><tr><td>8</td></tr></table>');

        const d = ctx.sheets[0].data!;
        // nothing written — the guard bailed out, the merge survives untouched
        expect(d[1][0]).toBeNull();
        expect(d[2][0]).toBeNull();
        expect(ctx.sheets[0].config!.merge).toEqual({ '0_0': { r: 0, c: 0, rs: 2, cs: 2 } });
    });
});
