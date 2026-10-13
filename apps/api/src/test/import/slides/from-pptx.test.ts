import { describe, expect, test } from 'bun:test';
import { ApiError } from '../../../lib/core/errors';
import { importError, MAX_PPTX_WEIGHT, readPptx } from '../../../lib/import/slides/from-pptx';
import { MAX_SLIDES } from '../../../lib/import/slides/package';
import { MAX_ELEMENTS, MAX_MEDIA_PARTS } from '../../../lib/import/slides/shapes';
import { box, buildPptx, NS, PIXEL_PNG, para, pic, pptxParts, rel, solid, sp, zipParts } from '../../fixtures/pptx';

// The reader's output and the limits a hostile pptx meets before the work they bound.

const OPTIONS = { width: 1920, height: 1080, maxMediaBytes: 35 * 1024 * 1024 };
const TOO_LARGE = 'This presentation is too large to import';

describe('a deck read', () => {
    test("is one slide per slide part, named by its title, with the file's slide size", () => {
        const deck = readPptx(
            buildPptx({
                sldSz: '<p:sldSz cx="9144000" cy="6858000"/>',
                slides: [
                    { shapes: sp({ ph: '<p:ph type="title"/>', xfrm: box(0, 0, 10, 10), text: para('Intro') }) },
                    {},
                ],
            }),
            OPTIONS,
        );
        expect(deck.slides.map((slide) => slide.name)).toEqual(['Intro', '']);
        expect(deck.slideSize).toEqual({ cx: 9144000, cy: 6858000 });
    });

    test('a slide size outside what PowerPoint allows is held to its range, a missing one is 4:3', () => {
        const size = (sldSz: string) => readPptx(buildPptx({ sldSz, slides: [{}] }), OPTIONS).slideSize;
        expect(size('<p:sldSz cx="99999999999999" cy="0"/>')).toEqual({ cx: 51206400, cy: 6858000 });
        expect(size('<p:sldSz cx="12" cy="-5"/>')).toEqual({ cx: 914400, cy: 6858000 });
        expect(size('')).toEqual({ cx: 9144000, cy: 6858000 });
    });

    test('names its pictures under a prefix of its own, so a second import into the deck overwrites none', () => {
        const pptx = buildPptx({
            slides: [
                {
                    shapes: pic({ xfrm: box(0, 0, 10, 10), embed: 'rId2' }),
                    rels: rel('rId2', 'image', '../media/image1.png'),
                },
            ],
            files: { 'ppt/media/image1.png': PIXEL_PNG },
        });
        const [first, second] = [readPptx(pptx, OPTIONS), readPptx(pptx, OPTIONS)];
        expect(first.media[0].name).toMatch(/^pptx-[0-9a-f]{8}-image-1\.png$/);
        expect(first.media[0].name).not.toBe(second.media[0].name);
    });
});

describe('limits', () => {
    const refusal = (bytes: Uint8Array, options = OPTIONS) => {
        try {
            readPptx(bytes, options);
        } catch (error) {
            return error instanceof ApiError ? [error.status, error.message] : error;
        }
        return 'read';
    };
    const filled = sp({ xfrm: box(0, 0, 1, 1), spPr: solid('FF0000') });

    test(`more than ${MAX_SLIDES} slides is refused before a slide is read`, () => {
        const ids = (count: number) =>
            Array.from({ length: count }, (_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 10}"/>`).join('');
        const presentation = (count: number) =>
            `<p:presentation ${NS}><p:sldIdLst>${ids(count)}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>`;
        expect(refusal(buildPptx({ slides: [{}], presentation: presentation(MAX_SLIDES + 1) }))).toEqual([
            413,
            TOO_LARGE,
        ]);
        expect(refusal(buildPptx({ slides: [{}], presentation: presentation(MAX_SLIDES) }))).toBe('read');
    });

    test(`more than ${MAX_ELEMENTS} elements after the master's are copied is too large`, () => {
        // The master's 39 shapes and the slide's own on each of 500 slides: 20,000.
        const master = filled.repeat(39);
        const slides = Array.from({ length: 500 }, () => ({ shapes: filled }));
        expect(refusal(buildPptx({ masters: [{ shapes: master }], slides }))).toBe('read');
        expect(refusal(buildPptx({ masters: [{ shapes: master + filled }], slides }))).toEqual([413, TOO_LARGE]);
    });

    test(`a master's undrawn shapes count too, as they are walked again for every slide`, () => {
        const unpainted = sp({ xfrm: box(0, 0, 1, 1) }).repeat(41);
        const slides = Array.from({ length: 500 }, () => ({}));
        expect(refusal(buildPptx({ masters: [{ shapes: unpainted }], slides }))).toEqual([413, TOO_LARGE]);
    });

    test(`more than ${MAX_MEDIA_PARTS} pictures, or more picture bytes than the upload cap, is too large`, () => {
        const pictures = (count: number) => {
            const parts = pptxParts({
                slides: [
                    {
                        shapes: Array.from({ length: count }, (_, i) =>
                            pic({ xfrm: box(0, 0, 1, 1), embed: `rId${i + 2}` }),
                        ).join(''),
                        rels: Array.from({ length: count }, (_, i) =>
                            rel(`rId${i + 2}`, 'image', `../media/image${i}.png`),
                        ).join(''),
                    },
                ],
            });
            for (let i = 0; i < count; i++) parts[`ppt/media/image${i}.png`] = PIXEL_PNG;
            return zipParts(parts);
        };
        expect(refusal(pictures(MAX_MEDIA_PARTS))).toBe('read');
        expect(refusal(pictures(MAX_MEDIA_PARTS + 1))).toEqual([413, TOO_LARGE]);
        const tight = { ...OPTIONS, maxMediaBytes: PIXEL_PNG.length * 2 };
        expect(refusal(pictures(2), tight)).toBe('read');
        expect(refusal(pictures(3), tight)).toEqual([413, TOO_LARGE]);
    });

    test(`the elements and their text are weighed against ${MAX_PPTX_WEIGHT} before an update is built`, () => {
        // A master's text, copied onto every slide: four 60,000-character boxes weigh 472 a slide.
        const big = sp({ xfrm: box(0, 0, 1, 1), txBox: true, text: para('x'.repeat(60_000)) }).repeat(4);
        const slides = (count: number) => Array.from({ length: count }, () => ({}));
        expect(refusal(buildPptx({ masters: [{ shapes: big }], slides: slides(100) }))).toBe('read');
        expect(refusal(buildPptx({ masters: [{ shapes: big }], slides: slides(110) }))).toEqual([413, TOO_LARGE]);
    });

    test('a stack the file outgrew is too large, a slip of the reader is a file it cannot read', () => {
        const overflow = importError(new RangeError('Maximum call stack size exceeded.'));
        expect(overflow).toMatchObject({ status: 413, message: TOO_LARGE });
        const slip = importError(new TypeError('x is undefined'));
        expect(slip).toMatchObject({ status: 400, message: 'Not a valid pptx file' });
    });
});
