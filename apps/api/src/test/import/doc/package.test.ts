import { describe, expect, test } from 'bun:test';
import { extentOf, vmlPx } from '../../../lib/import/doc/package';
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

    test('a side that is not positive is 0', () => {
        expect(extentOf(extent('cx="-952500" cy="0"'))).toEqual({ cx: 0, cy: 0 });
    });
});

describe('vmlPx', () => {
    // A 300-digit length is finite, so only the cap keeps it out.
    test('is none past 64 characters, before it is parsed: no length needs more', () => {
        expect(vmlPx(`${'0'.repeat(61)}5px`, 'emu')).toBe(5);
        expect(vmlPx(`${'0'.repeat(62)}5px`, 'emu')).toBeNull();
        expect(vmlPx(`${'0'.repeat(63)}5`, 'px')).toBe(5);
        expect(vmlPx(`${'9'.repeat(300)}px`, 'px')).toBeNull();
        expect(vmlPx(`${'9'.repeat(300)}`, 'px')).toBeNull();
    });
});
