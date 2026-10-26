import { describe, expect, test } from 'bun:test';
import type { MathRow } from '@workspace/math';
import { MATHML_NAMESPACE, writeMathml } from '@workspace/math';
import { readStoredEquation } from '../../lib/document/equation';

const x: MathRow = [{ kind: 'identifier', text: 'x' }];
const empty = {
    row: [],
    latex: undefined,
    mathml: `<math xmlns="${MATHML_NAMESPACE}"></math>`,
    text: '',
    display: false,
};

describe('readStoredEquation', () => {
    test("reads a stored equation through Bun's parser", () => {
        const mathml = writeMathml(x, 'x');
        expect(readStoredEquation({ mathml, display: true })).toEqual({
            row: x,
            latex: 'x',
            mathml,
            text: 'x',
            display: true,
        });
    });

    // The browser's DOMParser reports these in the document, Bun's parser throws: both read as an empty equation.
    test('a string Bun refuses reads as an empty equation', () => {
        for (const mathml of [
            `<math xmlns="${MATHML_NAMESPACE}"><mi>x</mi>`,
            `<!DOCTYPE math [<!ENTITY e "x">]><math xmlns="${MATHML_NAMESPACE}"><mi>&e;</mi></math>`,
            'x^2',
            '',
        ]) {
            expect(readStoredEquation({ mathml })).toEqual(empty);
        }
    });
});
