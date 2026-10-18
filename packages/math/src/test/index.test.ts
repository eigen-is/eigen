import { expect, test } from 'bun:test';
import * as math from '../index';

test('the barrel exports the API and nothing else', () => {
    expect(Object.keys(math).sort()).toEqual([
        'LATEX_COMMANDS',
        'MARKUP_COMPATIBILITY_NAMESPACE',
        'MATHML_NAMESPACE',
        'MATH_LIMITS',
        'MathError',
        'OMML_NAMESPACE',
        'WORDML_NAMESPACE',
        'fromDom',
        'mathText',
        'readLatex',
        'readMathml',
        'readMathmlLatex',
        'readOmml',
        'readOmmlText',
        'writeLatex',
        'writeMathml',
        'writeOmml',
        'writeText',
    ]);
});
