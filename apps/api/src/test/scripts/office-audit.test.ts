import { describe, expect, test } from 'bun:test';
import { chartsNotImported } from '../../scripts/office-audit';

describe('the charts a first import left out', () => {
    test('are as many as its reader counted, by the kind each placeholder names', () => {
        const output = [
            { type: 'text', text: 'Scatter chart not imported' },
            { html: '<p>Pie of Pie chart not imported</p><p>Sales</p>' },
            { text: 'Chart not imported' },
            { text: 'A chart not imported last year is no placeholder' },
        ];
        expect(chartsNotImported([{ code: 'charts-dropped', count: 4 }], output)).toEqual({
            count: 4,
            kinds: { Scatter: 1, 'Pie of Pie': 1, '(none named)': 1, '(no placeholder)': 1 },
        });
    });

    test('none counted is none, whatever the text says', () => {
        expect(chartsNotImported([{ code: 'images-dropped', count: 1 }], ['Scatter chart not imported'])).toEqual({
            count: 0,
            kinds: {},
        });
    });
});
