import { describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import {
    EIGEN_CLIPBOARD_RENDER_ATTR,
    embedClipboardSvgMetadata,
    extractClipboardSvgMetadata,
    hasRichHtmlBeyondMarker,
    inlineClipboardSvgMedia,
    materializeClipboardSvg,
    readSvgClipboardWithItems,
    svgToImageDataUri,
    svgToImageFile,
    writeEigenClipboardAsync,
} from '../../../core/clipboard/clipboard';
import type { EigenClipboardData, EigenClipboardImageItem, EigenClipboardItem } from '../../../types/clipboard';
import type { DrivePath } from '../../../types/drive';
import { eigenMediaHref } from '../../../vector/media-refs';

// hasRichHtmlBeyondMarker parses text/html with DOMParser — install happy-dom at module scope the way
// the classify test does.
// biome-ignore lint/suspicious/noExplicitAny: test-only globalThis injection
const g = globalThis as any;
g.DOMParser = new Window().DOMParser;

const EIGEN_MIME = 'application/eigen-clipboard';

// A minimal DataTransfer stand-in: the read functions under test only ever call getData.
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

describe('svgToImageFile', () => {
    test('wraps the string as an image/svg+xml File', async () => {
        const file = svgToImageFile(SVG);
        expect(file.type).toBe('image/svg+xml');
        expect(file.name).toBe('drawing.svg');
        expect(await file.text()).toBe(SVG);
    });
});

// A full, valid DrivePath for an uploaded media file — no casts, only the fields matter that
// reUploadImage reads (`name`, `id`), the rest are honest defaults.
function makeDrivePath(over: Partial<DrivePath> & Pick<DrivePath, 'id' | 'name'>): DrivePath {
    return {
        mountId: 'mt-target',
        type: 'file',
        parentId: 'media-target',
        ownerId: 'o-target',
        mimeType: 'image/png',
        size: 1,
        hash: null,
        thumbnail: null,
        acl: null,
        visibility: 'private',
        sharingRestricted: false,
        details: null,
        trashedAt: null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
        ...over,
    };
}

function imageItem(
    over: Partial<EigenClipboardImageItem> & Pick<EigenClipboardImageItem, 'mediaName'>,
): EigenClipboardImageItem {
    return {
        type: 'image',
        sourcePathId: `path-${over.mediaName}`,
        sourceParentId: 'media-source',
        sourceOwnerId: 'o-source',
        sourceMountId: 'mt-source',
        width: 100,
        height: 80,
        ...over,
    };
}

const svgWith = (...names: string[]): string => {
    const images = names.map((n) => `<image href="${eigenMediaHref(n)}" width="10" height="10"/>`).join('');
    return `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">${images}</svg>`;
};

// A fetch stub for reUploadImage's credentialed download leg — every ref resolves to a tiny blob.
// `preconnect` is carried over from the real fetch so the stub satisfies Bun's `typeof fetch`.
function stubFetch(): void {
    const impl = async () => new Response(new Blob(['x'], { type: 'image/png' }), { status: 200 });
    globalThis.fetch = Object.assign(impl, { preconnect: globalThis.fetch.preconnect });
}

describe('materializeClipboardSvg', () => {
    test('rewrites a re-uploaded ref to its final (collision-renamed) name', async () => {
        stubFetch();
        const svg = svgWith('a.png');
        const items: EigenClipboardItem[] = [imageItem({ mediaName: 'a.png' })];
        const upload = mock(async () => makeDrivePath({ id: 'new1', name: 'a (1).png' }));

        const file = await materializeClipboardSvg(svg, items, 'media-target', upload);
        const out = await file.text();

        expect(upload).toHaveBeenCalledTimes(1);
        expect(out).toContain(eigenMediaHref('a (1).png'));
        expect(out).not.toContain(eigenMediaHref('a.png'));
        expect(file.type).toBe('image/svg+xml');
    });

    test('same-folder paste keeps the name and never re-uploads', async () => {
        stubFetch();
        const svg = svgWith('a.png');
        const items: EigenClipboardItem[] = [imageItem({ mediaName: 'a.png', sourceParentId: 'media-target' })];
        const upload = mock(async () => makeDrivePath({ id: 'x', name: 'x.png' }));

        const out = await (await materializeClipboardSvg(svg, items, 'media-target', upload)).text();

        expect(upload).not.toHaveBeenCalled();
        expect(out).toBe(svg);
    });

    test('strips the href when the re-upload fails', async () => {
        stubFetch();
        const svg = svgWith('a.png');
        const items: EigenClipboardItem[] = [imageItem({ mediaName: 'a.png' })];
        const upload = mock(async () => null);

        const out = await (await materializeClipboardSvg(svg, items, 'media-target', upload)).text();

        expect(out).not.toContain('eigen-media:');
        expect(out).toContain('<image ');
    });

    test('strips a ref that has no matching typed item (forged/dropped)', async () => {
        stubFetch();
        const svg = svgWith('ghost.png');
        const upload = mock(async () => makeDrivePath({ id: 'x', name: 'x.png' }));

        const out = await (await materializeClipboardSvg(svg, [], 'media-target', upload)).text();

        expect(upload).not.toHaveBeenCalled();
        expect(out).not.toContain('eigen-media:');
    });

    test('passes a no-image svg through untouched, no uploads', async () => {
        stubFetch();
        const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>';
        const upload = mock(async () => makeDrivePath({ id: 'x', name: 'x.png' }));

        const out = await (await materializeClipboardSvg(svg, [], 'media-target', upload)).text();

        expect(upload).not.toHaveBeenCalled();
        expect(out).toBe(svg);
    });

    test('round-trips a name with an apostrophe through a collision rename', async () => {
        stubFetch();
        const svg = svgWith("Bob's chart.png");
        const items: EigenClipboardItem[] = [imageItem({ mediaName: "Bob's chart.png" })];
        const upload = mock(async () => makeDrivePath({ id: 'n', name: "Bob's chart (1).png" }));

        const out = await (await materializeClipboardSvg(svg, items, 'media-target', upload)).text();

        expect(out).toContain(eigenMediaHref("Bob's chart (1).png"));
        expect(out).not.toContain(eigenMediaHref("Bob's chart.png"));
    });

    test('leaves a traversal-name ref alone (parseEigenMediaHref rejects it)', async () => {
        stubFetch();
        // eigen-media:a%2Fb.png decodes to "a/b.png" — rejected by parseEigenMediaHref, so
        // listEigenMediaRefs never surfaces it: no fetch, no upload, token untouched.
        const forged = 'eigen-media:a%2Fb.png';
        const svg = `<svg xmlns="http://www.w3.org/2000/svg"><image href="${forged}"/></svg>`;
        const upload = mock(async () => makeDrivePath({ id: 'x', name: 'x.png' }));

        const out = await (await materializeClipboardSvg(svg, [], 'media-target', upload)).text();

        expect(upload).not.toHaveBeenCalled();
        expect(out).toBe(svg);
    });

    test('handles a mix: one re-upload rename, one failure strip', async () => {
        stubFetch();
        const svg = svgWith('a.png', 'b.png');
        const items: EigenClipboardItem[] = [imageItem({ mediaName: 'a.png' }), imageItem({ mediaName: 'b.png' })];
        const upload = mock(async (args: { parentId: string; file: File }) =>
            args.file.name === 'a.png' ? makeDrivePath({ id: 'na', name: 'a (1).png' }) : null,
        );

        const out = await (await materializeClipboardSvg(svg, items, 'media-target', upload)).text();

        expect(out).toContain(eigenMediaHref('a (1).png'));
        expect(out).not.toContain(eigenMediaHref('b.png'));
    });
});

describe('inlineClipboardSvgMedia', () => {
    test('rewrites every eigen-media ref to a base64 data URI, svg otherwise intact', async () => {
        const svg = svgWith('a.png');
        const fetcher = mock(async (_name: string) => new Blob(['AAA'], { type: 'image/png' }));
        const out = await inlineClipboardSvgMedia(svg, fetcher);
        expect(out).not.toBeNull();
        expect(out).not.toContain('eigen-media:');
        expect(out).toContain('href="data:image/png;base64,');
        // The drawing wrapper around the <image> is untouched.
        expect(out?.startsWith('<svg')).toBe(true);
        expect(out).toContain('width="10"');
        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    test('strips the ref of an image whose fetch returns null, inlines the rest', async () => {
        const svg = svgWith('a.png', 'b.png');
        const fetcher = mock(async (name: string) =>
            name === 'b.png' ? null : new Blob(['AAA'], { type: 'image/png' }),
        );
        const out = await inlineClipboardSvgMedia(svg, fetcher);
        expect(out).toContain('href="data:image/png;base64,'); // a.png inlined
        expect(out).not.toContain(eigenMediaHref('b.png')); // b.png stripped
        expect(out).not.toContain('eigen-media:');
        expect(out).toContain('<image '); // the stripped element survives, just href-less
    });

    test('returns null when the inlined payload exceeds the soft cap', async () => {
        const svg = svgWith('big.png');
        const big = new Uint8Array(4 * 1024 * 1024); // 4MB raw → ~5.5MB base64 > 4MB cap
        const fetcher = mock(async () => new Blob([big], { type: 'image/png' }));
        expect(await inlineClipboardSvgMedia(svg, fetcher)).toBeNull();
    });

    test('returns a ref-free svg unchanged and never fetches', async () => {
        const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>';
        const fetcher = mock(async () => new Blob(['x'], { type: 'image/png' }));
        expect(await inlineClipboardSvgMedia(svg, fetcher)).toBe(svg);
        expect(fetcher).not.toHaveBeenCalled();
    });
});

describe('svgToImageDataUri', () => {
    test('encodes a (UTF-8) svg as a base64 image/svg+xml data URI', async () => {
        const svg = '<svg xmlns="http://www.w3.org/2000/svg">café ✓</svg>';
        const uri = await svgToImageDataUri(svg);
        const prefix = 'data:image/svg+xml;base64,';
        expect(uri.startsWith(prefix)).toBe(true);
        const bytes = Uint8Array.from(atob(uri.slice(prefix.length)), (c) => c.charCodeAt(0));
        expect(new TextDecoder().decode(bytes)).toBe(svg);
    });
});

describe('readSvgClipboardWithItems', () => {
    test('hands back the eigen payload svg together with its typed items', () => {
        const items: EigenClipboardItem[] = [imageItem({ mediaName: 'a.png' })];
        const data = { version: 1 as const, items, svg: SVG };
        const result = readSvgClipboardWithItems(stubClipboard({ [EIGEN_MIME]: JSON.stringify(data) }));
        expect(result?.svg).toBe(SVG);
        expect(result?.items).toEqual(items);
    });

    test('a foreign SVG on text/plain has an empty item list', () => {
        const result = readSvgClipboardWithItems(stubClipboard({ 'text/plain': SVG }));
        expect(result?.svg).toBe(SVG);
        expect(result?.items).toEqual([]);
    });

    test('returns null when there is no SVG to paste', () => {
        expect(readSvgClipboardWithItems(stubClipboard({ 'text/plain': 'just text' }))).toBeNull();
    });
});

describe('hasRichHtmlBeyondMarker', () => {
    const marker = '<span data-eigen-clipboard="x"></span>';
    const IMG_SRC = 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=';

    test('marker + our render-marked <img> → false (the vector foreign-render img is ignored)', () => {
        const html = `${marker}<img ${EIGEN_CLIPBOARD_RENDER_ATTR}="" src="${IMG_SRC}">`;
        expect(hasRichHtmlBeyondMarker(stubClipboard({ 'text/html': html }))).toBe(false);
    });

    test('marker + a foreign unmarked <img> → true (real rich html, unchanged)', () => {
        const html = `${marker}<img src="${IMG_SRC}">`;
        expect(hasRichHtmlBeyondMarker(stubClipboard({ 'text/html': html }))).toBe(true);
    });

    test('marker only → false', () => {
        expect(hasRichHtmlBeyondMarker(stubClipboard({ 'text/html': marker }))).toBe(false);
    });
});

describe('writeEigenClipboardAsync', () => {
    // biome-ignore lint/suspicious/noExplicitAny: test-only globalThis injection
    const gg = globalThis as any;

    test('a rejecting html promise still resolves the write with a marker-only text/html', async () => {
        const captured: { items?: Record<string, Blob | Promise<Blob>> } = {};
        gg.ClipboardItem = class {
            constructor(public items: Record<string, Blob | Promise<Blob>>) {}
        };
        const origNavigator = gg.navigator;
        gg.navigator = {
            clipboard: {
                // biome-ignore lint/suspicious/noExplicitAny: minimal ClipboardItem stub
                write: async (list: any[]) => {
                    captured.items = list[0].items;
                },
            },
        };
        try {
            const data: EigenClipboardData = {
                version: 1,
                items: [{ type: 'text', text: 'x', width: 1, height: 1 }],
            };
            // The svg inliner's fetch rejecting must NOT abort the whole write.
            await writeEigenClipboardAsync(data, 'plain fallback', Promise.reject(new Error('inliner failed')));

            const htmlBlob = await captured.items?.['text/html'];
            const html = await htmlBlob?.text();
            // Marker survives even though the html promise rejected...
            expect(html).toContain('data-eigen-clipboard=');
            // ...and it degraded to marker-only (no appended html body).
            expect(html?.endsWith('</span>')).toBe(true);
            // ...and the text/plain fallback is still on the clipboard.
            expect(captured.items?.['text/plain']).toBeDefined();
        } finally {
            gg.navigator = origNavigator;
        }
    });
});
