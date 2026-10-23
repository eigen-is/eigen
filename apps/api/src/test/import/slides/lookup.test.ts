import { describe, expect, test } from 'bun:test';
import { ApiError } from '../../../lib/core/errors';
import { type XmlElement, xmlAttr } from '../../../lib/core/xml';
import {
    affords,
    charge,
    childOf,
    childrenOf,
    firstChildOf,
    prefixedAttrOf,
    spend,
    withWorkBudget,
} from '../../../lib/import/slides/lookup';
import { A_NS, P_NS, parseOoxml, R_NS } from '../../../lib/ooxml/ooxml';
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

    test("charges the read's work budget for a scan of many children once, and nothing for a few", () => {
        const level = parse(`<a:lvl1pPr ${NS}>${'<a:x/>'.repeat(1000)}<a:defRPr/></a:lvl1pPr>`);
        const refused = () => withWorkBudget(1000, () => childOf(level, A_NS, 'defRPr'));
        expect(refused).toThrow(new ApiError(413, 'This presentation is too large to import'));
        withWorkBudget(1001, () => {
            for (let i = 0; i < 1000; i++) childOf(level, A_NS, 'defRPr');
        });
        withWorkBudget(2 * 1001, () => {
            for (let i = 0; i < 1000; i++) {
                childrenOf(level, A_NS, 'x');
                firstChildOf(level, isFill);
            }
        });
        const few = parse(`<a:lvl1pPr ${NS}><a:x/><a:defRPr/></a:lvl1pPr>`);
        withWorkBudget(0, () => {
            childOf(few, A_NS, 'defRPr');
            childrenOf(few, A_NS, 'x');
            firstChildOf(few, isFill);
        });
    });

    test('answers whether the work left covers an amount, charging nothing', () => {
        withWorkBudget(10, () => {
            expect(affords(10)).toBe(true);
            expect(affords(11)).toBe(false);
            charge(4);
            expect(affords(6)).toBe(true);
            expect(affords(7)).toBe(false);
            charge(6);
        });
    });

    test('spends an amount the work left covers, and none of one it does not', () => {
        withWorkBudget(10, () => {
            expect(spend(11)).toBe(false);
            expect(spend(4)).toBe(true);
            expect(affords(6)).toBe(true);
            expect(affords(7)).toBe(false);
        });
    });

    test('keeps a prefixed attribute for an element of many attributes, and reads a few again', () => {
        // A run's hyperlink is read once: keeping it would hold every run's.
        const link = parse(`<a:hlinkClick ${NS} r:id="rId1"/>`);
        expect(prefixedAttrOf(link, R_NS, 'id')).toBe('rId1');
        link.attributes['r:id'] = 'rId2';
        expect(prefixedAttrOf(link, R_NS, 'id')).toBe('rId2');
        const junk = Array.from({ length: 20 }, (_, i) => `r:x${i}="x"`).join(' ');
        const blip = parse(`<a:blip ${NS} ${junk} r:embed="rId1"/>`);
        withWorkBudget(21, () => {
            for (let i = 0; i < 1000; i++) expect(prefixedAttrOf(blip, R_NS, 'embed')).toBe('rId1');
        });
        blip.attributes['r:embed'] = 'rId2';
        expect(prefixedAttrOf(blip, R_NS, 'embed')).toBe('rId1');
    });
});
