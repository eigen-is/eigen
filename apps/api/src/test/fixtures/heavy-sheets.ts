import type { CellMatrix, Op, Sheet } from '@workspace/lib/sheets';
import type * as Y from 'yjs';
import { writeSheetsToYjs } from '../../lib/document/sheets';

// Deterministic sheet fixtures for the document-transform work (preview golden tests
// and the responsiveness benchmark). Everything is derived from cell coordinates —
// no randomness, no clock — so rendered output is byte-stable across runs and the
// golden hash in sheets-preview.test.ts stays valid.
//
// Two sizes:
//   - buildGoldenSheets(): small, within any preview budget; exercises formulas
//     (recalc gate ON: `f` without `v`), conditional formatting (default + dataBar +
//     cross-sheet formula rule), merges, borders, hyperlinks (allowed + blocked
//     scheme), rotation, and hostile strings the sanitizer must defang.
//   - buildHeavySheets(rows, cols): first sheet far beyond the preview budget, dense
//     formulas + CF over the whole grid, a cross-sheet formula tail, and a marker in
//     the far corner so tests can detect whether the deep end was rendered.

function num(r: number, c: number): number {
    return (r * 31 + c * 17) % 997;
}

function colLetter(c: number): string {
    let s = '';
    let n = c;
    do {
        s = String.fromCharCode(65 + (n % 26)) + s;
        n = Math.floor(n / 26) - 1;
    } while (n >= 0);
    return s;
}

function numberCell(r: number, c: number) {
    const v = num(r, c);
    return { v, m: String(v), ct: { fa: 'General', t: 'n' } };
}

function textCell(text: string) {
    return { v: text, m: text, ct: { fa: 'General', t: 'g' } };
}

// `f` without `v`/`m` and no sheet calcChain → sheetsNeedRecalc fires. Only the
// export read recalcs these; preview and extract serve them uncomputed (empty).
function formulaCell(formula: string) {
    return { f: formula };
}

export const GOLDEN_HEADERS = ['Region', 'Q1', 'Q2', 'Q3', 'Q4', 'Total', 'Status', 'Notes'] as const;
export const GOLDEN_ROWS = 24;
export const GOLDEN_COLS = 8;
// num(1,1..4) = 48, 65, 82, 99 — asserted as the computed `=SUM(B2:E2)` result.
export const GOLDEN_ROW1_TOTAL = 48 + 65 + 82 + 99;
export const GOLDEN_XSS = '<script>alert("xss")</script>';
export const GOLDEN_SHEET2_MARKER = 'SHEET2-ONLY-CONTENT';
export const GOLDEN_OPS_EDIT = 'OPS-EDIT-APPLIED';

export function buildGoldenSheets(): Sheet[] {
    const data: CellMatrix = [];
    for (let r = 0; r < GOLDEN_ROWS; r++) {
        const row: CellMatrix[number] = [];
        for (let c = 0; c < GOLDEN_COLS; c++) {
            if (r === 0) {
                row.push(textCell(GOLDEN_HEADERS[c]));
            } else if (c === 0) {
                row.push(textCell(`Region ${r}`));
            } else if (c === 5) {
                row.push(formulaCell(`=SUM(B${r + 1}:E${r + 1})`));
            } else if (c === 6) {
                row.push(formulaCell(`=IF(F${r + 1}>1500,"high","low")`));
            } else if (c === 7) {
                row.push(r === 21 ? textCell(GOLDEN_XSS) : null);
            } else {
                row.push(numberCell(r, c));
            }
        }
        data.push(row);
    }
    // Style + rotation coverage on fixed cells.
    data[2][7] = { ...textCell('styled'), bl: 1, it: 1, fc: '#7a1f1f', bg: '#fff4cc' };
    data[3][7] = { ...textCell('tilted'), rt: 45 };

    const sheet1: Sheet = {
        id: 'sheet-1',
        name: 'Dashboard',
        order: 0,
        data,
        config: {
            merge: { '0_0': { r: 0, c: 0, rs: 1, cs: 2 } },
            borderInfo: [
                {
                    rangeType: 'cell',
                    value: {
                        row_index: 1,
                        col_index: 1,
                        l: { style: 8, color: '#1a5fb4' },
                        b: { style: 1, color: '#1a5fb4' },
                    },
                },
            ],
            columnlen: { '0': 120 },
            rowlen: { '0': 28 },
        },
        conditionalFormatRules: [
            {
                type: 'default',
                cellrange: [{ row: [1, GOLDEN_ROWS - 1], column: [1, 4] }],
                format: { cellColor: '#ffe08a', textColor: '#7a1f1f' },
                conditionName: 'greaterThan',
                conditionValue: [500],
            },
            {
                type: 'dataBar',
                cellrange: [{ row: [1, GOLDEN_ROWS - 1], column: [1, 1] }],
                format: ['#638ec6'],
            },
            // Cross-sheet formula rule — pins the resolver spanning every sheet, not
            // only the rendered first one.
            {
                type: 'default',
                cellrange: [{ row: [1, GOLDEN_ROWS - 1], column: [2, 2] }],
                format: { cellColor: '#d1f0d1' },
                conditionName: 'formula',
                conditionValue: ['=Data!A1>10'],
            },
        ],
        hyperlink: {
            '1_0': { linkType: 'webpage', linkAddress: 'https://example.com/report' },
            '2_0': { linkType: 'webpage', linkAddress: 'javascript:alert(1)' },
        },
    };

    const sheet2: Sheet = {
        id: 'sheet-2',
        name: 'Data',
        order: 1,
        data: [
            [numberCell(1, 1), textCell(GOLDEN_SHEET2_MARKER)],
            [formulaCell('=Dashboard!B2*2'), textCell('second sheet')],
        ],
        config: {},
    };

    const sheet3: Sheet = { id: 'sheet-3', name: 'Empty', order: 2, celldata: [], config: {} };

    return [sheet1, sheet2, sheet3];
}

export const GOLDEN_OPS_PARTIAL_EDIT = 'ops-partial-m';

export function buildGoldenOps(): Op[][] {
    return [
        [{ op: 'replace', id: 'sheet-1', path: ['data', 5, 7], value: textCell(GOLDEN_OPS_EDIT) }],
        // Field-level patch on an existing cell (whole-cell replaces are batch 1).
        [{ op: 'replace', id: 'sheet-1', path: ['data', 6, 0, 'm'], value: GOLDEN_OPS_PARTIAL_EDIT }],
    ];
}

export const HEAVY_FAR_CORNER = 'FAR-CORNER';

export function buildHeavySheets(rows = 600, cols = 45): Sheet[] {
    const data: CellMatrix = [];
    for (let r = 0; r < rows; r++) {
        const row: CellMatrix[number] = [];
        for (let c = 0; c < cols; c++) {
            if (r === 0) {
                row.push(textCell(`H${colLetter(c)}`));
            } else if (c > 0 && c % 5 === 0) {
                row.push(formulaCell(`=SUM(${colLetter(c - 4)}${r + 1}:${colLetter(c - 1)}${r + 1})`));
            } else {
                row.push(numberCell(r, c));
            }
        }
        data.push(row);
    }
    data[rows - 1][cols - 1] = textCell(HEAVY_FAR_CORNER);

    const big: Sheet = {
        id: 'sheet-big',
        name: 'Big',
        order: 0,
        data,
        config: {},
        conditionalFormatRules: [
            {
                type: 'default',
                cellrange: [{ row: [1, rows - 1], column: [0, cols - 1] }],
                format: { cellColor: '#fde3e3' },
                conditionName: 'greaterThan',
                conditionValue: [900],
            },
            {
                type: 'dataBar',
                cellrange: [{ row: [1, rows - 1], column: [1, 1] }],
                format: ['#638ec6'],
            },
        ],
    };

    const refRows = Math.min(rows, 200);
    const refData: CellMatrix = [];
    for (let r = 0; r < refRows; r++) {
        refData.push([formulaCell(`=Big!A${r + 1}*2`), numberCell(r, 1)]);
    }
    const refs: Sheet = { id: 'sheet-refs', name: 'Refs', order: 1, data: refData, config: {} };

    return [big, refs];
}

export function buildHeavyOps(batches = 40, opsPerBatch = 25, rows = 600, cols = 45): Op[][] {
    const result: Op[][] = [];
    for (let b = 0; b < batches; b++) {
        const batch: Op[] = [];
        for (let i = 0; i < opsPerBatch; i++) {
            const r = 1 + ((b * opsPerBatch + i) % (rows - 2));
            const c = (b + i) % Math.min(cols, 4);
            batch.push({ op: 'replace', id: 'sheet-big', path: ['data', r, c], value: numberCell(r + b, c + 1) });
        }
        result.push(batch);
    }
    return result;
}

// Seeds a collab doc the way the editor does: one snapshot write, then each op
// batch in its own transaction so data.db accumulates a real update-row history
// (the capture path must carry snapshot + updates, not a single consolidated blob).
export function seedSheetsDoc(doc: Y.Doc, sheets: Sheet[], opBatches: Op[][]): void {
    writeSheetsToYjs(doc, sheets);
    for (const batch of opBatches) {
        doc.transact(() => {
            doc.getArray<Op[]>('ops').push([batch]);
        });
    }
}
