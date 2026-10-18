import { describe, expect, test } from 'bun:test';
import { bundledFont } from '@workspace/lib/constants/fonts';
import { ApiError } from '../../../lib/core/errors';
import { A_NS, parseOoxml } from '../../../lib/core/ooxml';
import { fontLook, readLooks, themePalette } from '../../../lib/import/sheets/styles';
import { OFFICE_COLORS, SML } from '../../fixtures/xlsx';

// What a cell takes from its xf: one look per xf, resolved once.

const PALETTE = themePalette(
    parseOoxml(
        `<a:theme xmlns:a="${A_NS}"><a:themeElements><a:clrScheme name="Office">${OFFICE_COLORS}</a:clrScheme></a:themeElements></a:theme>`,
    ) ?? undefined,
);

const looks = (inner: string) =>
    readLooks(parseOoxml(`<styleSheet xmlns="${SML}">${inner}</styleSheet>`) ?? undefined, PALETTE);
const xfs = (...xf: string[]) => `<cellXfs>${xf.join('')}</cellXfs>`;
const font = (inner: string) => `<fonts><font/><font>${inner}</font></fonts>`;

describe('the theme palette', () => {
    test("lists SpreadsheetML's order, light before dark, from srgbClr or a system colour's last value", () => {
        expect(PALETTE.slice(0, 5)).toEqual(['#FFFFFF', '#000000', '#E7E6E6', '#44546A', '#4472C4']);
        expect(PALETTE).toHaveLength(12);
    });

    test('is empty without a theme, so a theme colour resolves to none', () => {
        expect(themePalette(undefined)).toEqual([]);
        expect(
            readLooks(
                parseOoxml(
                    `<styleSheet xmlns="${SML}">${font('<color theme="4"/>')}${xfs('<xf/>', '<xf fontId="1"/>')}</styleSheet>`,
                ) ?? undefined,
                [],
            )[1].cell.fc,
        ).toBeUndefined();
    });
});

describe('a number format', () => {
    test('a built-in id reads as its code, and a date code is a date', () => {
        const [, date, percent] = looks(xfs('<xf/>', '<xf numFmtId="14"/>', '<xf numFmtId="9"/>'));
        expect(date).toMatchObject({ numFmt: 'mm-dd-yy', fa: 'MM-dd-yy', isDate: true });
        expect(percent).toMatchObject({ numFmt: '0%', fa: '0%', isDate: false });
    });

    test("a custom code is kept as written, its escapes too, and wins over a built-in id's", () => {
        const [, escaped, hours] = looks(
            `<numFmts><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/><numFmt numFmtId="2" formatCode="0\\h"/></numFmts>${xfs('<xf/>', '<xf numFmtId="164"/>', '<xf numFmtId="2"/>')}`,
        );
        expect(escaped).toMatchObject({ numFmt: 'yyyy\\-mm\\-dd', fa: 'yyyy\\-MM\\-dd', isDate: true });
        // An escaped letter is a literal, not a date token.
        expect(hours).toMatchObject({ numFmt: '0\\h', isDate: false });
    });

    // A long code read once per xf was a 4 KB zip that held the reader for a minute; past 1,000 formats they're refused.
    test('is resolved once however many cell formats name it', () => {
        const code = 'h:mm:ss '.repeat(31);
        const resolved = looks(
            `<numFmts><numFmt numFmtId="164" formatCode="${code}"/></numFmts>${xfs(...Array.from({ length: 2_000 }, () => '<xf numFmtId="164"/>'))}`,
        );
        expect(resolved[1999]).toMatchObject({ numFmt: code, isDate: true });
    });

    // Each was a 1 MB code, which every display parsed again: 1,000 cells formatted for over two minutes.
    test("a code past Excel's 255 characters is General, and one numfmt can't parse keeps its code but shows General", () => {
        const [, longest, longer, malformed] = looks(
            `<numFmts><numFmt numFmtId="164" formatCode="${'0'.repeat(255)}"/><numFmt numFmtId="165" formatCode="${'0'.repeat(256)}"/><numFmt numFmtId="166" formatCode="0;m00[h"/></numFmts>${xfs('<xf/>', '<xf numFmtId="164"/>', '<xf numFmtId="165"/>', '<xf numFmtId="166"/>')}`,
        );
        expect(longest).toMatchObject({ numFmt: '0'.repeat(255), fa: '0'.repeat(255) });
        expect(longer).toMatchObject({ numFmt: undefined, fa: undefined, isDate: false });
        expect(malformed).toMatchObject({ numFmt: undefined, fa: '0;M00[h', isDate: false });
    });

    test('cell formats naming more than 1,000 formats are too large', () => {
        const ids = Array.from({ length: 1_001 }, (_, index) => 164 + index);
        const many = (count: number) =>
            looks(
                `<numFmts>${ids.map((id) => `<numFmt numFmtId="${id}" formatCode="0.${'0'.repeat(id % 30)}"/>`).join('')}</numFmts>${xfs('<xf/>', ...ids.slice(0, count).map((id) => `<xf numFmtId="${id}"/>`))}`,
            );
        expect(many(1_000)).toHaveLength(1_001);
        expect(() => many(1_001)).toThrow(new ApiError(413, 'Spreadsheet too large'));
    });

    test('General, id 0 or an id nothing names is no format', () => {
        for (const look of looks(
            `<numFmts><numFmt numFmtId="165" formatCode="General"/></numFmts>${xfs('<xf numFmtId="0"/>', '<xf numFmtId="165"/>', '<xf numFmtId="999"/>')}`,
        ))
            expect(look.fa).toBeUndefined();
    });
});

describe('a font', () => {
    test('maps weight, slant, underline, strike, size, a bundled family and a colour', () => {
        const [, look] = looks(
            `${font('<b/><i/><u/><strike/><sz val="14"/><name val="Arial"/><color rgb="FF112233"/>')}${xfs('<xf/>', '<xf fontId="1"/>')}`,
        );
        expect(look.cell).toEqual({ bl: 1, it: 1, un: 1, cl: 1, fs: 14, ff: bundledFont('Arial'), fc: '#112233' });
    });

    test("an off value is off, and a 'none' underline no underline", () => {
        const [, look] = looks(
            `${font('<b val="0"/><i val="false"/><u val="none"/><strike val="0"/>')}${xfs('<xf/>', '<xf fontId="1"/>')}`,
        );
        expect(look.cell).toEqual({});
    });

    test('a theme colour takes its tint; a family Eigen has no font for sets none', () => {
        const [, look] = looks(
            `${font('<color theme="4" tint="0.5"/><name val="Wingdings Fancy"/><sz val="10.5"/>')}${xfs('<xf/>', '<xf fontId="1"/>')}`,
        );
        expect(look.cell).toEqual({ fc: '#A2B9E2', fs: 10.5 });
    });

    test("a run's properties read as a font, its face named by rFont", () => {
        const rPr =
            parseOoxml(`<rPr xmlns="${SML}"><b/><rFont val="Courier New"/><color theme="1"/></rPr>`) ?? undefined;
        expect(fontLook(rPr, PALETTE)).toEqual({ bl: 1, ff: bundledFont('Courier New'), fc: '#000000' });
    });
});

describe('a fill', () => {
    test('a pattern other than none paints its foreground', () => {
        const fills =
            '<fills><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor theme="5"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="none"><fgColor rgb="FF00FF00"/></patternFill></fill></fills>';
        const [, none, gray, solid, noneColored] = looks(
            `${fills}${xfs('<xf/>', '<xf fillId="0"/>', '<xf fillId="1"/>', '<xf fillId="2"/>', '<xf fillId="3"/>')}`,
        );
        expect([none.cell, gray.cell, solid.cell, noneColored.cell]).toEqual([{}, {}, { bg: '#ED7D31' }, {}]);
    });
});

describe('an alignment', () => {
    test('maps horizontal, vertical, wrap and rotation', () => {
        const [, a, b, c, d] = looks(
            xfs(
                '<xf/>',
                '<xf><alignment horizontal="center" vertical="center" wrapText="1" textRotation="45"/></xf>',
                '<xf><alignment horizontal="right" vertical="top" textRotation="135"/></xf>',
                '<xf><alignment textRotation="255"/></xf>',
                '<xf><alignment horizontal="general" vertical="bottom"/></xf>',
            ),
        );
        expect(a).toMatchObject({ cell: { ht: 0, vt: 0, tb: '2', rt: 45 }, aligned: true });
        expect(b).toMatchObject({ cell: { ht: 2, vt: 1, rt: -45 }, aligned: true });
        expect(c).toMatchObject({ cell: { rt: 'vertical' }, aligned: false });
        // General names an alignment Eigen draws by default, so a number keeps no right alignment.
        expect(d).toMatchObject({ cell: { vt: 2 }, aligned: true });
    });
});

describe('a border', () => {
    test('maps each side to its style and colour, black by default, and diagonalDown to the slash', () => {
        const borders = `<borders><border/><border diagonalDown="1" diagonalUp="1"><left style="thin"><color rgb="FFFF0000"/></left><right style="medium"/><top style="nonsense"/><bottom/><diagonal style="dashed"><color theme="4"/></diagonal></border><border diagonalUp="1"><diagonal style="thin"/></border></borders>`;
        const [, none, sides, up] = looks(
            `${borders}${xfs('<xf/>', '<xf borderId="0"/>', '<xf borderId="1"/>', '<xf borderId="2"/>')}`,
        );
        expect(none.border).toBeUndefined();
        expect(sides.border).toEqual({
            l: { style: 1, color: '#FF0000' },
            r: { style: 8, color: '#000000' },
            s: { style: 4, color: '#4472C4' },
        });
        // Eigen's slash runs top-left to bottom-right only.
        expect(up.border).toBeUndefined();
    });
});

describe('the cell formats', () => {
    test('xf 0 is the workbook default, which Eigen draws with its own look', () => {
        const [first] = looks(
            `${font('<b/>')}<fills><fill><patternFill patternType="solid"><fgColor rgb="FF00FF00"/></patternFill></fill></fills>${xfs('<xf fontId="1" fillId="0" numFmtId="9"/>')}`,
        );
        expect(first).toEqual({ cell: {}, font: {}, aligned: false, isDate: false });
    });

    test('an index past its list takes nothing from it', () => {
        const [, look] = looks(xfs('<xf/>', '<xf fontId="7" fillId="7" borderId="7"/>'));
        expect(look).toEqual({ cell: {}, font: {}, aligned: false, isDate: false });
    });

    test('no styles part is no looks', () => {
        expect(readLooks(undefined, PALETTE)).toEqual([]);
    });
});
