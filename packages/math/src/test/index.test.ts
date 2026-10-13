import { expect, test } from 'bun:test';
import * as math from '../index';

test('the barrel exports the API and nothing else', () => {
    expect(Object.keys(math).sort()).toEqual([
        'LATEX_COMMANDS',
        'MATHML_NAMESPACE',
        'MATH_LIMITS',
        'MathError',
        'OMML_NAMESPACE',
        'WORDML_NAMESPACE',
        'fromDom',
        'readLatex',
        'readMathml',
        'readOmml',
        'writeLatex',
        'writeMathml',
        'writeOmml',
        'writeText',
    ]);
});
