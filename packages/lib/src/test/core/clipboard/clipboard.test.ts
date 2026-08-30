import { describe, expect, test } from 'bun:test';
import {
    embedClipboardSvgMetadata,
    extractClipboardSvgMetadata,
    readSvgClipboard,
    svgToImageFile,
} from '../../../core/clipboard/clipboard';
import type { EigenClipboardData } from '../../../types/clipboard';

const EIGEN_MIME = 'application/eigen-clipboard';

// A minimal DataTransfer stand-in: readEigenClipboard/readSvgClipboard only ever call getData.
function stubClipboard(map: Record<string, string>): DataTransfer {
    return { getData: (type: string) => map[type] ?? '' } as unknown as DataTransfer;
}

const sampleData = (): EigenClipboardData => ({
    version: 1,
    items: [
        { type: 'text', text: 'hello', width: 40, height: 12 },
        {
            type: 'image',
            mediaName: 'a.png',
            sourcePathId: 'p1',
            sourceParentId: 'm1',
            sourceOwnerId: 'o1',
            sourceMountId: 'mt1',
            width: 100,
            height: 80,
        },
    ],
});

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>';

describe('embedClipboardSvgMetadata / extractClipboardSvgMetadata', () => {
    test('round-trips the element JSON through the <metadata> block', () => {
        const data = sampleData();
        const embedded = embedClipboardSvgMetadata(SVG, data);
        expect(embedded.startsWith('<svg')).toBe(true);
        expect(embedded).toContain('<metadata');
        // The drawing body survives untouched.
        expect(embedded).toContain('<rect width="10" height="10"/>');

        const extracted = extractClipboardSvgMetadata(embedded);
        expect(extracted).toEqual({ version: 1, items: data.items, svg: undefined });
    });

    test('embeds items only — never the svg field itself (no nesting)', () => {
        const data: EigenClipboardData = { ...sampleData(), svg: SVG };
        const extracted = extractClipboardSvgMetadata(embedClipboardSvgMetadata(SVG, data));
        expect(extracted?.svg).toBeUndefined();
        expect(extracted?.items).toEqual(data.items);
    });

    test('returns null for an SVG with no eigen metadata', () => {
        expect(extractClipboardSvgMetadata(SVG)).toBeNull();
    });

    test('drops items with non-finite dims on extract (forgeable wire)', () => {
        const forged = embedClipboardSvgMetadata(SVG, {
            version: 1,
            items: [{ type: 'text', text: 'x', width: Number.NaN, height: 5 }],
        });
        expect(extractClipboardSvgMetadata(forged)?.items).toEqual([]);
    });
});

describe('readSvgClipboard', () => {
    test('returns the eigen payload svg field first', () => {
        const data: EigenClipboardData = { version: 1, items: [], svg: SVG };
        const svg = readSvgClipboard(stubClipboard({ [EIGEN_MIME]: JSON.stringify(data) }));
        expect(svg).toBe(SVG);
    });

    test('falls back to an <svg-leading text/plain (a foreign SVG)', () => {
        expect(readSvgClipboard(stubClipboard({ 'text/plain': SVG }))).toBe(SVG);
    });

    test('tolerates (and trims) leading whitespace before <svg', () => {
        expect(readSvgClipboard(stubClipboard({ 'text/plain': `\n  ${SVG}` }))).toBe(SVG);
    });

    test('returns null for non-svg text with no eigen payload', () => {
        expect(readSvgClipboard(stubClipboard({ 'text/plain': 'just some text' }))).toBeNull();
    });

    test('an <svg snippet without the SVG namespace stays text', () => {
        expect(readSvgClipboard(stubClipboard({ 'text/plain': '<svg width="10"><rect/></svg>' }))).toBeNull();
    });
});

describe('svgToImageFile', () => {
    test('wraps the string as an image/svg+xml File', async () => {
        const file = svgToImageFile(SVG);
        expect(file.type).toBe('image/svg+xml');
        expect(file.name).toBe('drawing.svg');
        expect(await file.text()).toBe(SVG);
    });
});
