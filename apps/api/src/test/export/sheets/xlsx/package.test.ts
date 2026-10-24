import { describe, expect, test } from 'bun:test';
import type { Sheet } from '@workspace/lib/sheets';
import type { CountedWarningCode } from '../../../../lib/document/transform/protocol';
import { activeTabOf, sheetNames, workbookXml } from '../../../../lib/export/sheets/xlsx/package';

function namesOf(names: string[]) {
    const lost: CountedWarningCode[] = [];
    const written = sheetNames(
        names.map((name) => ({ name })),
        (code) => lost.push(code),
    );
    return { written, changed: lost.filter((code) => code === 'sheet-names-changed').length };
}

describe("a sheet's name in the workbook", () => {
    test('is kept when Excel takes it', () => {
        expect(namesOf(['Sheet1', "It's", 'Data (2)', 'Ünïcødé 表'])).toEqual({
            written: ['Sheet1', "It's", 'Data (2)', 'Ünïcødé 表'],
            changed: 0,
        });
    });

    test('loses the characters Excel refuses and the quotes at its ends; an empty one is named by its place', () => {
        expect(namesOf(['a/b\\c?d*e[f]g:h', "'quoted'", "''", 'ok'])).toEqual({
            written: ['a_b_c_d_e_f_g_h', 'quoted', 'Sheet3', 'ok'],
            changed: 3,
        });
    });

    test('History, which Excel keeps for itself, is numbered as Excel numbers a copy', () => {
        expect(namesOf(['history', 'History (2)']).written).toEqual(['history (3)', 'History (2)']);
    });

    test('a name that clashes in any case is numbered past every name the workbook holds, the first keeping it', () => {
        expect(namesOf(['Data', 'DATA', 'Data (2)', 'data']).written).toEqual([
            'Data',
            'DATA (3)',
            'Data (2)',
            'data (4)',
        ]);
    });

    test('is cut to 31 characters, and a clash the cut makes is numbered within them', () => {
        const long = 'Quarterly revenue by region and product';
        const { written, changed } = namesOf([`${long} A`, `${long} B`, 'x'.repeat(31)]);
        expect(written).toEqual(['Quarterly revenue by region and', 'Quarterly revenue by region (2)', 'x'.repeat(31)]);
        expect(changed).toBe(2);
        for (const name of written) expect(name.length).toBeLessThanOrEqual(31);
    });

    test('a repair that lands on a name the workbook holds is numbered, and the holder keeps its name', () => {
        expect(namesOf(['a/b', 'a_b']).written).toEqual(['a_b (2)', 'a_b']);
    });
});

describe('the workbook part', () => {
    const sheets: Sheet[] = [
        { name: 'Hidden', hide: 1, celldata: [] },
        { name: 'Shown', celldata: [], filterRange: { row: [1, 9], column: [1, 3] } },
        { name: 'Later', hide: 1, celldata: [] },
    ];

    test('opens on the first sheet shown; with every sheet hidden, on the first, shown', () => {
        expect(activeTabOf(sheets)).toBe(1);
        expect(activeTabOf([{ hide: 1 }, { hide: 1 }])).toBe(0);
    });

    test('lists its sheets, the hidden ones hidden, and a filter database name per filtered sheet', () => {
        const xml = workbookXml(sheets, ['Hidden', 'Shown', 'Later'], ['rId1', 'rId2', 'rId3'], 1);
        expect(xml).toContain('<bookViews><workbookView activeTab="1"/></bookViews>');
        expect(xml).toContain(
            [
                '<sheets>',
                '<sheet name="Hidden" sheetId="1" state="hidden" r:id="rId1"/>',
                '<sheet name="Shown" sheetId="2" r:id="rId2"/>',
                '<sheet name="Later" sheetId="3" state="hidden" r:id="rId3"/>',
                '</sheets>',
                '<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="1" hidden="1">&apos;Shown&apos;!$B$2:$D$10</definedName></definedNames>',
            ].join(''),
        );
    });
});
