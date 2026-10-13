import { describe, expect, test } from 'bun:test';
import { readMathml, writeMathml } from '../mathml';
import { readOmml } from '../omml';
import type { MathNode } from '../tree';
import { canonicalIssue } from './canonical';
import { CORPUS } from './corpus';
import { generateTree } from './generate';
import { el } from './parse';

// C2: the stored MathML is lossless, so with C1 docx → stored → docx is the full trip.
describe('C2: tree → MathML → tree is the identity', () => {
    for (const equation of CORPUS) {
        test(`fixture #${equation.i}`, () => {
            const tree = readOmml(el(equation.omml));
            const read = readMathml(el(writeMathml(tree))).row;
            expect(read).toStrictEqual(tree);
            expect(canonicalIssue(read)).toBeUndefined();
        });
    }

    test('1,000 seeded canonical trees', () => {
        for (let seed = 1; seed <= 1000; seed++) {
            const tree = generateTree(seed);
            expect({ seed, issue: canonicalIssue(tree) }).toEqual({ seed, issue: undefined });
            expect({ seed, tree: readMathml(el(writeMathml(tree))).row }).toStrictEqual({ seed, tree });
        }
    });
});

describe('canonicalIssue', () => {
    test.each([
        { kind: 'table', layout: 'matrix', rows: [] },
        { kind: 'table', layout: 'matrix', rows: [[]] },
        { kind: 'table', layout: 'equations', rows: [[[]], []] },
        { kind: 'text', text: '\tif' },
        { kind: 'text', text: 'a\nb' },
        { kind: 'text', text: '\r' },
        { kind: 'identifier', text: 'x', color: 'red' },
        { kind: 'text', text: 'x', color: '#ff0000' },
    ] satisfies MathNode[])('rejects %j', (node) => {
        expect(canonicalIssue([node])).toBeDefined();
    });
});
