import { describe, expect, test } from 'bun:test';
import { A_NS, P_NS, parseOoxml } from '../../../lib/core/ooxml';
import { type XmlElement, xmlAttr } from '../../../lib/core/xml';
import { childOf, childrenOf, firstChildOf } from '../../../lib/import/slides/lookup';
import { countVisits, NS } from '../../fixtures/pptx';

// The reader's lookups into an element: a layout's, master's or theme's is looked into again by everything inheriting
// it, so its children are scanned once.

const parse = (xml: string) => {
    const element = parseOoxml(xml);
    if (!element) throw new Error(`not XML: ${xml}`);
    return element;
};

const isFill = (child: XmlElement) => child.ns === A_NS && child.local.endsWith('Fill');

describe('a lookup', () => {
    test('finds what xmlChild, xmlChildren and a find over the children find, in a few children or indexed many', () => {
        for (const junk of ['', '<a:x/>'.repeat(20)]) {
            const spPr = parse(
                `<p:spPr ${NS}>${junk}<a:ln w="1"/><a:noFill/><a:ln w="2"/><a:solidFill/><p:ln w="3"/></p:spPr>`,
            );
            const width = (ln: XmlElement | undefined) => ln && xmlAttr(ln, '', 'w');
            expect(width(childOf(spPr, A_NS, 'ln'))).toBe('1');
            expect(width(childOf(spPr, P_NS, 'ln'))).toBe('3');
            expect(childOf(spPr, A_NS, 'prstGeom')).toBeUndefined();
            expect(childrenOf(spPr, A_NS, 'ln').map(width)).toEqual(['1', '2']);
            expect(firstChildOf(spPr, isFill)?.local).toBe('noFill');
        }
    });

    test("reads an element's children once, however many lookups follow", () => {
        const level = parse(`<a:lvl1pPr ${NS}>${'<a:x/>'.repeat(1000)}<a:defRPr/><a:buChar/></a:lvl1pPr>`);
        const count = countVisits(level);
        for (let i = 0; i < 1000; i++) {
            childOf(level, A_NS, 'defRPr');
            childOf(level, A_NS, 'lnSpc');
            childrenOf(level, A_NS, 'x');
            firstChildOf(level, isFill);
        }
        // Once for the index, once for the named list, once for the test.
        expect(count.visits).toBe(3 * 1002);
    });
});
