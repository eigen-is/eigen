import { expect, test } from 'bun:test';
import { writeText } from '../text';
import type { MathRow } from '../tree';
import { letter } from './parse';

const number = (text: string): MathRow => [{ kind: 'number', text }];
const operator = (text: string): MathRow => [{ kind: 'operator', text }];
const sum = (a: string, b: string): MathRow => [...letter(a), ...operator('+'), ...letter(b)];

test.each<[MathRow, string]>([
    [[...letter('x'), ...operator('+'), ...number('1')], 'x+1'],
    [
        [
            { kind: 'identifier', text: 'v', variant: 'bold' },
            { kind: 'identifier', text: 'R', variant: 'double-struck' },
            { kind: 'number', text: '0', variant: 'bold-italic' },
        ],
        '𝐯ℝ0',
    ],
    [[{ kind: 'text', text: 'if ', color: '#FF0000' }, ...letter('x')], 'if x'],
    [[...letter('x'), { kind: 'space', width: 'qquad' }, ...letter('y')], 'x y'],
    [[{ kind: 'fraction', numerator: sum('a', 'b'), denominator: number('2'), line: 'bar' }], '(a+b)/2'],
    // A space inside an object stays, so (a b)/x never reads as ab/x.
    [
        [
            {
                kind: 'fraction',
                numerator: [...letter('a'), { kind: 'space', width: 'normal' }, ...letter('b')],
                denominator: letter('x'),
                line: 'bar',
            },
        ],
        '(a b)/x',
    ],
    // UnicodeMath's ¦ stacks without a bar, so a binomial never reads as n over k.
    [
        [
            {
                kind: 'fenced',
                open: '(',
                close: ')',
                separator: '',
                parts: [[{ kind: 'fraction', numerator: letter('n'), denominator: letter('k'), line: 'none' }]],
            },
        ],
        '(n¦k)',
    ],
    [[{ kind: 'scripts', base: letter('x'), sub: letter('i'), sup: number('2') }], 'x_i^2'],
    [[{ kind: 'scripts', base: letter('x'), sup: sum('n', 'm') }], 'x^(n+m)'],
    [[{ kind: 'scripts', base: letter('X'), sub: letter('a'), sup: letter('b'), pre: true }], '_a^b X'],
    // A lone compound operand is parenthesised too, so a/b^2 never means (a/b)^2.
    [
        [
            {
                kind: 'scripts',
                base: [{ kind: 'fraction', numerator: letter('a'), denominator: letter('b'), line: 'bar' }],
                sup: number('2'),
            },
        ],
        '(a/b)^2',
    ],
    [
        [{ kind: 'scripts', base: [{ kind: 'scripts', base: letter('x'), sup: number('2') }], sup: number('3') }],
        '(x^2)^3',
    ],
    // A compound operand never runs into the next node: x^24 would be x to the 24.
    [[{ kind: 'scripts', base: letter('x'), sup: number('2') }, ...number('4')], 'x^2 4'],
    [[{ kind: 'scripts', base: letter('x'), sub: letter('i') }, ...letter('y')], 'x_i y'],
    [[{ kind: 'fraction', numerator: letter('a'), denominator: letter('b'), line: 'bar' }, ...letter('c')], 'a/b c'],
    [[{ kind: 'function', name: letter('sin'), body: number('12') }, ...number('3')], 'sin 12 3'],
    [[{ kind: 'scripts', base: letter('x'), sup: number('2') }, ...operator('+'), ...number('4')], 'x^2+4'],
    [[{ kind: 'radical', body: letter('x') }], '√x'],
    [[{ kind: 'radical', body: sum('x', 'y') }], '√(x+y)'],
    [[{ kind: 'radical', body: letter('x'), degree: number('3') }], '∛x'],
    [[{ kind: 'radical', body: letter('x'), degree: number('4') }], '∜x'],
    [[{ kind: 'radical', body: letter('x'), degree: letter('n') }], '√(n&x)'],
    [
        [
            {
                kind: 'nary',
                operator: '∑',
                limits: 'under',
                sub: [...letter('i'), ...operator('='), ...number('1')],
                sup: letter('n'),
                body: letter('i'),
            },
        ],
        '∑_(i=1)^n i',
    ],
    [[{ kind: 'fenced', open: '(', close: ')', separator: ',', parts: [letter('a'), letter('b')] }], '(a,b)'],
    [[{ kind: 'fenced', open: '{', close: '}', separator: '│', parts: [letter('x'), sum('x', 'y')] }], '{x│x+y}'],
    [[{ kind: 'function', name: letter('sin'), body: letter('x') }], 'sin x'],
    [[{ kind: 'function', name: letter('sin'), body: [] }], 'sin'],
    [
        [
            {
                kind: 'function',
                name: letter('sin'),
                body: [{ kind: 'fenced', open: '(', close: ')', separator: '', parts: [letter('x')] }],
            },
        ],
        'sin(x)',
    ],
    [[{ kind: 'accent', accent: '\u0302', body: letter('x') }], 'x\u0302'],
    [[{ kind: 'line', position: 'over', body: letter('x') }], 'x\u0305'],
    [[{ kind: 'line', position: 'under', body: sum('a', 'b') }], '(a+b)\u0332'],
    [[{ kind: 'brace', char: '⏞', position: 'over', body: sum('a', 'b') }], '(a+b)┬⏞'],
    [
        [
            {
                kind: 'limit',
                position: 'under',
                base: letter('lim'),
                limit: [...letter('n'), ...operator('→'), ...operator('∞')],
            },
        ],
        'lim┴(n→∞)',
    ],
    [[{ kind: 'enclose', notation: ['top', 'bottom', 'left', 'right'], body: sum('a', 'b') }], '▭(a+b)'],
    [
        [
            {
                kind: 'table',
                layout: 'matrix',
                rows: [
                    [letter('a'), letter('b')],
                    [letter('c'), letter('d')],
                ],
            },
        ],
        '■(a&b@c&d)',
    ],
    [[{ kind: 'table', layout: 'equations', rows: [[letter('x'), [...operator('='), ...number('1')]]] }], '█(x&=1)'],
])('%j', (row, text) => {
    expect(writeText(row)).toBe(text);
});
