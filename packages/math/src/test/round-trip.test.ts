import { describe, expect, test } from 'bun:test';
import { readOmml } from '../omml';
import type { MathNode } from '../tree';
import { canonicalIssue } from './canonical';
import { CORPUS } from './corpus';
import { generateTree, seedChunks } from './generate';
import { el, viaMathml } from './parse';

// The stored MathML is lossless, so with the OMML round trip docx → stored → docx is the full trip.
describe('tree → MathML → tree is the identity', () => {
    for (const equation of CORPUS) {
        test(`fixture #${equation.i}`, () => {
            const tree = readOmml(el(equation.omml));
            const read = viaMathml(tree);
            expect(read).toStrictEqual(tree);
            expect(canonicalIssue(read)).toBeUndefined();
        });
    }

    test.each(seedChunks(5000))('seeded canonical trees %i to %i', (first, last) => {
        for (let seed = first; seed <= last; seed++) {
            const tree = generateTree(seed);
            expect({ seed, issue: canonicalIssue(tree) }).toEqual({ seed, issue: undefined });
            expect({ seed, tree: viaMathml(tree) }).toStrictEqual({ seed, tree });
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
