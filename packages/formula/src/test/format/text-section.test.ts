import { describe, expect, test } from 'bun:test';
import { numberDisplay } from '../../format';
import { DIV0, NA } from '../../values/errors';

// The ten formats of Excel for the web's table, read on 16 November 2026. The colour of a section is not part of
// the display string.
const FORMATS = [
    '0.00',
    '0;-0;0;"T:"@',
    '@" kg"',
    '"x"@"y"',
    ';;;',
    ';;;@',
    '0;0;0;"only literal"',
    '[Red]0;[Red]0;[Red]0;[Green]@',
    '"lit"',
    '0" units"',
] as const;

// Every cell of that table, a value's display under each format in order. A formula's text and a formula's TRUE
// are values as any other here: the handle's test takes them through a workbook.
const EXCEL = [
    ['abc', 'abc', ['abc', 'T:abc', 'abc kg', 'xabcy', '', 'abc', 'only literal', 'abc', 'abc', 'abc']],
    ['text 12', '12', ['12', 'T:12', '12 kg', 'x12y', '', '12', 'only literal', '12', '12', '12']],
    ['TRUE', true, ['TRUE', 'T:TRUE', 'TRUE kg', 'xTRUEy', '', 'TRUE', 'only literal', 'TRUE', 'TRUE', 'TRUE']],
    [
        'FALSE',
        false,
        ['FALSE', 'T:FALSE', 'FALSE kg', 'xFALSEy', '', 'FALSE', 'only literal', 'FALSE', 'FALSE', 'FALSE'],
    ],
    [
        '#DIV/0!',
        DIV0,
        [
            '#DIV/0!',
            'T:#DIV/0!',
            '#DIV/0! kg',
            'x#DIV/0!y',
            '',
            '#DIV/0!',
            'only literal',
            '#DIV/0!',
            '#DIV/0!',
            '#DIV/0!',
        ],
    ],
    ['#N/A', NA, ['#N/A', 'T:#N/A', '#N/A kg', 'x#N/Ay', '', '#N/A', 'only literal', '#N/A', '#N/A', '#N/A']],
    ['="abc"', 'abc', ['abc', 'T:abc', 'abc kg', 'xabcy', '', 'abc', 'only literal', 'abc', 'abc', 'abc']],
    ['=1=1', true, ['TRUE', 'T:TRUE', 'TRUE kg', 'xTRUEy', '', 'TRUE', 'only literal', 'TRUE', 'TRUE', 'TRUE']],
    ['5', 5, ['5.00', '5', '5', '5', '', '', '5', '5', 'lit', '5 units']],
    ['=""', '', ['', 'T:', ' kg', 'xy', '', '', 'only literal', '', '', '']],
] as const;

describe("a value's display follows Excel's text section", () => {
    test.each(EXCEL)('%s under each of the ten formats', (_, value, shown) => {
        expect(FORMATS.map((fa) => numberDisplay(value, fa))).toEqual([...shown]);
    });

    test('a boolean and an error under General show as they are', () => {
        expect([numberDisplay(true), numberDisplay(false), numberDisplay(DIV0)]).toEqual(['TRUE', 'FALSE', '#DIV/0!']);
    });
});
