import { describe, expect, test } from 'bun:test';
import { classifyPaste } from '../../../core/clipboard/classify';
import { embedClipboardSvgMetadata } from '../../../core/clipboard/clipboard';
import type { EigenClipboardData, EigenClipboardImageItem, EigenClipboardTextItem } from '../../../types/clipboard';

const EIGEN_MIME = 'application/eigen-clipboard';
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>';
// The exact string the sheet's own copy emits (packages/sheet/.../selection.ts COPY_ACTION_TABLE_MARKER).
const SHEET_MARKER = 'sheet-copy-action-table';

// A minimal DataTransfer stand-in: the classifier reads via getData + .files only.
function stubClipboard(map: Record<string, string>, files: File[] = []): DataTransfer {
    return {
        getData: (type: string) => map[type] ?? '',
        files: files as unknown as FileList,
    } as unknown as DataTransfer;
}

const textItem = (over: Partial<EigenClipboardTextItem> = {}): EigenClipboardTextItem => ({
    type: 'text',
    text: 'hello',
    width: 40,
    height: 12,
    ...over,
});

const imageItem = (): EigenClipboardImageItem => ({
    type: 'image',
    mediaName: 'a.png',
    sourcePathId: 'p1',
    sourceParentId: 'm1',
    sourceOwnerId: 'o1',
    sourceMountId: 'mt1',
    width: 100,
    height: 80,
});

const markerHtml = (data: EigenClipboardData, extra = ''): string =>
    `<span data-eigen-clipboard="${encodeURIComponent(JSON.stringify(data))}"></span>${extra}`;

const pngFile = (name = 'a.png'): File => new File(['x'], name, { type: 'image/png' });
const textFile = (name = 'a.txt'): File => new File(['x'], name, { type: 'text/plain' });

describe('classifyPaste', () => {
    test('eigen-only payload → eigen present, svg absent', () => {
        const data: EigenClipboardData = { version: 1, items: [textItem()] };
        const c = classifyPaste(stubClipboard({ [EIGEN_MIME]: JSON.stringify(data), 'text/html': markerHtml(data) }));
        expect(c.eigen?.items).toEqual(data.items);
        expect(c.svg).toBeUndefined();
    });

    test('eigen + svg (vector copy) → svg with items intact; eigen also present', () => {
        const items = [textItem({ text: '' }), imageItem()];
        const svg = embedClipboardSvgMetadata(SVG, { version: 1, items });
        const data: EigenClipboardData = { version: 1, items, svg };
        const c = classifyPaste(stubClipboard({ [EIGEN_MIME]: JSON.stringify(data) }));
        expect(c.svg?.svg).toBe(svg);
        expect(c.svg?.items).toEqual(items);
        expect(c.eigen?.items).toEqual(items);
    });

    test('eigen + svg + extra html <img> (unit-4 shape) → eigen/svg still returned, html must not suppress them', () => {
        const items = [imageItem()];
        const svg = embedClipboardSvgMetadata(SVG, { version: 1, items });
        const data: EigenClipboardData = { version: 1, items, svg };
        const html = markerHtml(data, '<img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=">');
        const c = classifyPaste(stubClipboard({ [EIGEN_MIME]: JSON.stringify(data), 'text/html': html }));
        // The extra <img> is real HTML beyond the marker, but it must NOT suppress the eigen/svg flavours.
        expect(c.eigen?.items).toEqual(items);
        expect(c.svg?.svg).toBe(svg);
    });

    test('foreign whole-svg document on text/plain → svg present, items []', () => {
        const c = classifyPaste(stubClipboard({ 'text/plain': SVG }));
        expect(c.svg?.svg).toBe(SVG);
        expect(c.svg?.items).toEqual([]);
        expect(c.eigen).toBeUndefined();
    });

    test('an <svg> snippet on text/plain WITHOUT xmlns → not svg, stays text', () => {
        const snippet = '<svg width="10"><rect/></svg>';
        const c = classifyPaste(stubClipboard({ 'text/plain': snippet }));
        expect(c.svg).toBeUndefined();
        expect(c.text).toBe(snippet);
    });

    test('foreign rich html only → html set, eigen/svg absent', () => {
        const c = classifyPaste(stubClipboard({ 'text/html': '<p>pasted prose</p>', 'text/plain': 'pasted prose' }));
        expect(c.eigen).toBeUndefined();
        expect(c.svg).toBeUndefined();
        expect(c.html).toBe('<p>pasted prose</p>');
        expect(c.text).toBe('pasted prose');
    });

    test('OS image file only → imageFiles length 1, files length 1, no eigen/svg', () => {
        const c = classifyPaste(stubClipboard({}, [pngFile()]));
        expect(c.imageFiles).toHaveLength(1);
        expect(c.files).toHaveLength(1);
        expect(c.eigen).toBeUndefined();
        expect(c.svg).toBeUndefined();
    });

    test('mixed files → imageFiles is the image subset of files', () => {
        const c = classifyPaste(stubClipboard({}, [pngFile(), textFile()]));
        expect(c.files).toHaveLength(2);
        expect(c.imageFiles).toHaveLength(1);
        expect(c.imageFiles[0]?.type).toBe('image/png');
    });

    test('plain text only → text set, everything else empty', () => {
        const c = classifyPaste(stubClipboard({ 'text/plain': 'just text' }));
        expect(c.text).toBe('just text');
        expect(c.html).toBe('');
        expect(c.eigen).toBeUndefined();
        expect(c.svg).toBeUndefined();
        expect(c.files).toEqual([]);
        expect(c.imageFiles).toEqual([]);
    });

    test('sheets internal marker in html → svg/eigen suppressed, raw html surfaced', () => {
        const items = [imageItem()];
        const data: EigenClipboardData = {
            version: 1,
            items,
            svg: embedClipboardSvgMetadata(SVG, { version: 1, items }),
        };
        // A same-tab sheet copy also writes the eigen payload, but the marker means paste comes from
        // ctx.copyState — the classifier must suppress both flavours so the caller falls through.
        const html = `${markerHtml(data)}<table class="${SHEET_MARKER}"><tr><td>1</td></tr></table>`;
        const c = classifyPaste(stubClipboard({ [EIGEN_MIME]: JSON.stringify(data), 'text/html': html }), {
            internalMarkerText: SHEET_MARKER,
        });
        expect(c.svg).toBeUndefined();
        expect(c.eigen).toBeUndefined();
        // The raw html is still surfaced for the native table-paste fallthrough.
        expect(c.html).toBe(html);
    });

    test('non-internal html without the marker text → flavours read', () => {
        const data: EigenClipboardData = { version: 1, items: [textItem()] };
        const c = classifyPaste(stubClipboard({ [EIGEN_MIME]: JSON.stringify(data) }), {
            internalMarkerText: SHEET_MARKER,
        });
        expect(c.eigen?.items).toEqual(data.items);
    });

    test('forged non-finite dims → items dropped through the classifier', () => {
        const data = { version: 1, items: [{ type: 'text', text: 'x', width: Number.NaN, height: 5 }] };
        const c = classifyPaste(stubClipboard({ [EIGEN_MIME]: JSON.stringify(data) }));
        expect(c.eigen?.items).toEqual([]);
    });

    test('empty clipboard → all-empty struct', () => {
        const c = classifyPaste(stubClipboard({}));
        expect(c.eigen).toBeUndefined();
        expect(c.svg).toBeUndefined();
        expect(c.files).toEqual([]);
        expect(c.imageFiles).toEqual([]);
        expect(c.html).toBe('');
        expect(c.text).toBe('');
    });
});
