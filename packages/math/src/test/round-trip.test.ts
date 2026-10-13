import { describe, expect, test } from 'bun:test';
import { readMathml, writeMathml } from '../mathml';
import { readOmml } from '../omml';
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
            expect(read).toEqual(tree);
            expect(canonicalIssue(read)).toBeUndefined();
        });
    }

    test('1,000 seeded canonical trees', () => {
        for (let seed = 1; seed <= 1000; seed++) {
            const tree = generateTree(seed);
            expect({ seed, issue: canonicalIssue(tree) }).toEqual({ seed, issue: undefined });
            expect({ seed, tree: readMathml(el(writeMathml(tree))).row }).toEqual({ seed, tree });
        }
    });
});
