import { describe, expect, test } from 'bun:test';
import { numberOf } from '../../../components/charts/chart-data-grid';
import { fromPercent } from '../../../components/charts/percent';

// The number pattern before it was made linear. It backtracks quadratically on a long run of digits that doesn't
// match, but what it accepts is the contract.
const QUADRATIC_NUMBER_TEXT = /^([-+]?)[$€£¥]?(\d{1,3}(?:,\d{3})+(?:\.\d*)?|\d*\.?\d+(?:e[-+]?\d+)?)(%?)$/i;

function quadraticNumberOf(text: string): number | null {
    const trimmed = text.trim();
    if (trimmed === '') return null;
    const match = QUADRATIC_NUMBER_TEXT.exec(trimmed);
    if (!match) return Number.NaN;
    const [, sign, digits, percent] = match;
    const value = Number(`${sign}${digits.replaceAll(',', '')}`);
    return percent ? fromPercent(value) : value;
}

function* strings(alphabet: string[], length: number): Generator<string> {
    if (length === 0) {
        yield '';
        return;
    }
    for (const shorter of strings(alphabet, length - 1)) {
        for (const char of alphabet) yield shorter + char;
    }
}

describe('numberOf', () => {
    test('reads exactly what the earlier pattern read, as the same number', () => {
        const alphabet = ['1', '0', '.', ',', 'e', '-', '+', '$', '%', 'x', ' '];
        const texts = [
            ...Array.from({ length: 6 }, (_, n) => [...strings(alphabet, n)]).flat(),
            '1,000',
            '1,000.',
            '1,000.25',
            '12,345,678',
            '1,23',
            '-€5',
            '£1,234.00',
            '12%',
            '.5e-3',
            '1.e5',
            '1.5E+10',
            '00012',
        ];
        const differ = texts.filter((text) => !Object.is(numberOf(text), quadraticNumberOf(text)));
        expect(differ).toEqual([]);
    });

    test('a long run of digits that is no number is refused at once', () => {
        const text = `${'1'.repeat(40_000)}x`;
        const start = performance.now();
        expect(numberOf(text)).toBeNaN();
        expect(performance.now() - start).toBeLessThan(100);
    });
});
