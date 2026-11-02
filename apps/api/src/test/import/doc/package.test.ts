import { describe, expect, test } from 'bun:test';
import { extentOf } from '../../../lib/import/doc/package';
import { parseOoxml, WP_NS } from '../../../lib/ooxml/ooxml';

const extent = (attributes: string) => parseOoxml(`<wp:extent xmlns:wp="${WP_NS}" ${attributes}/>`) ?? undefined;

describe('extentOf', () => {
    test('reads cx and cy in EMU, a fraction rounded', () => {
        expect(extentOf(extent('cx="952500" cy="476250"'))).toEqual({ cx: 952500, cy: 476250 });
        expect(extentOf(extent('cx="100.6" cy="100.4"'))).toEqual({ cx: 101, cy: 100 });
    });

    test('a side that is missing, no number or infinite is 0', () => {
        expect(extentOf(undefined)).toEqual({ cx: 0, cy: 0 });
        expect(extentOf(extent('cy="476250"'))).toEqual({ cx: 0, cy: 476250 });
        expect(extentOf(extent('cx="wide" cy="1e400"'))).toEqual({ cx: 0, cy: 0 });
    });

    test('a negative side reads as it is, for the caller to refuse', () => {
        expect(extentOf(extent('cx="-952500" cy="0"'))).toEqual({ cx: -952500, cy: 0 });
    });
});
