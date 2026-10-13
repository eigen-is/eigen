import { describe, expect, test } from 'bun:test';
import { importSummary } from '../../lib/import/messages';

// The toast after a pptx Convert or Import: one short line per kind of loss, from the counted warnings.
describe('importSummary', () => {
    test('nothing lost says nothing', () => {
        expect(importSummary([])).toBeNull();
        expect(importSummary([{ code: 'recalc-failed', message: 'no' }])).toBeNull();
    });

    test('one of one kind is singular', () => {
        expect(importSummary([{ code: 'tables-dropped', count: 1 }])).toBe('1 table was not imported.');
    });

    test('kinds are listed in a fixed order, what was left out before what was simplified', () => {
        expect(
            importSummary([
                { code: 'shapes-simplified', count: 5 },
                { code: 'diagrams-dropped', count: 1 },
                { code: 'tables-dropped', count: 2 },
            ]),
        ).toBe('2 tables and 1 SmartArt graphic were not imported; 5 shapes were simplified.');
    });

    test('a picture that is not shown and one that is not imported are one kind', () => {
        expect(
            importSummary([
                { code: 'images-dropped', count: 1 },
                { code: 'images-unshown', count: 2 },
                { code: 'charts-dropped', count: 1 },
                { code: 'objects-dropped', count: 3 },
            ]),
        ).toBe('1 chart, 3 embedded objects and 3 pictures were not imported.');
    });

    test('every simplification has its noun', () => {
        expect(
            importSummary([
                { code: 'text-simplified', count: 1 },
                { code: 'mirrors-dropped', count: 2 },
                { code: 'fills-simplified', count: 396 },
            ]),
        ).toBe('396 fills, 1 text box and 2 flipped pictures were simplified.');
    });
});
