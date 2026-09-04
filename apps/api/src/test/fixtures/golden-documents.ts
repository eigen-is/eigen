import type { JSONContent } from '@tiptap/core';
import { getSchema } from '@tiptap/core';
import { getDocExtensions } from '@workspace/lib/docs/eigendoc';
import { escapeHtml } from '@workspace/lib/html';
import type { BackgroundFill } from '@workspace/lib/types/background';
import type { DrivePath } from '@workspace/lib/types/drive';
import {
    DEFAULT_ELEMENT_PROPS,
    DEFAULT_RICHTEXT_PROPS,
    DEFAULT_SKETCH_PROPS,
    FRAME_FIELDS,
    FRAME_HEIGHT,
    FRAME_WIDTH,
    generateNKeysBetween,
    serializeBackgroundFill,
    serializeFill,
    solidFill,
    TRANSPARENT_FILL,
    type VectorElement,
    type VectorFrame,
    type VectorRichTextElement,
    type VectorScene,
} from '@workspace/lib/vector';
import { common, createLowlight } from 'lowlight';
import * as Y from 'yjs';
import { writeEigendocToYjs } from '../../lib/document/doc';
import type { Mount } from '../../lib/mount';

// Deterministic eigendoc + eigenslides fixtures for the document-transform work
// (preview/export golden tests and the responsiveness benchmark). Everything is
// literal — no randomness, no clock — so rendered output is byte-stable across runs
// and the golden hashes in document-transform.test.ts stay valid.
//
// Two sizes, mirroring heavy-sheets.ts:
//   - buildGoldenDocJson() / buildGoldenDeckScene(): small. Deliberately over the preview
//     cap (24 blocks / 10 slides), carrying one media reference, hostile strings the
//     sanitizer must defang, and the node/element variants each renderer special-cases.
//   - buildHeavyDocJson(sections) / buildHeavyDeckScene(frames, elementsPerFrame): far
//     beyond any preview budget, size-tunable, no media — the render cost the
//     benchmark measures, not the feature coverage.

export const GOLDEN_MEDIA_NAME = 'pixel.png';
export const GOLDEN_BEYOND_CAP = 'BEYOND-PREVIEW-CAP';
const GOLDEN_DOC_XSS = '<script>alert("doc-xss")</script>';
const GOLDEN_DECK_XSS = '<p>legit body</p><script>alert("deck-xss")</script>';
const GOLDEN_DOC_LINK = 'https://example.com/report';

// The lowlight instance the doc renderers use — the schema must match, or a
// codeBlock node cannot be written into the Yjs document.
const docSchema = getSchema(getDocExtensions({ lowlight: createLowlight(common) }));

// The node shapes both builders lay out — a plain text block, and the list/table
// walks the renderers pay most for.
function paragraph(text: string): JSONContent {
    return { type: 'paragraph', content: [{ type: 'text', text }] };
}

function bulletList(items: string[]): JSONContent {
    return { type: 'bulletList', content: items.map((item) => ({ type: 'listItem', content: [paragraph(item)] })) };
}

function table(headers: string[], rows: string[][]): JSONContent {
    return {
        type: 'table',
        content: [
            {
                type: 'tableRow',
                content: headers.map((label) => ({ type: 'tableHeader', content: [paragraph(label)] })),
            },
            ...rows.map((cells) => ({
                type: 'tableRow',
                content: cells.map((cell) => ({ type: 'tableCell', content: [paragraph(cell)] })),
            })),
        ],
    };
}

export function buildGoldenDocJson(): JSONContent {
    const content: JSONContent[] = [
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Quarterly Report' }] },
        {
            type: 'paragraph',
            content: [
                { type: 'text', text: 'Prepared by the ' },
                { type: 'text', marks: [{ type: 'bold' }], text: 'growth' },
                { type: 'text', text: ' team, with ' },
                { type: 'text', marks: [{ type: 'italic' }], text: 'notes' },
                { type: 'text', text: ' and a ' },
                { type: 'text', marks: [{ type: 'link', attrs: { href: GOLDEN_DOC_LINK } }], text: 'reference' },
                { type: 'text', text: '.' },
            ],
        },
        {
            // Figures are inline atoms, so they live inside a paragraph.
            type: 'paragraph',
            content: [
                {
                    type: 'figure',
                    attrs: {
                        mediaName: GOLDEN_MEDIA_NAME,
                        alt: 'A pixel',
                        caption: 'Figure 1 — pixel',
                        width: 320,
                        alignment: 'center',
                        layout: 'block',
                    },
                },
            ],
        },
        {
            type: 'codeBlock',
            attrs: { language: 'javascript' },
            content: [{ type: 'text', text: 'const total = items.reduce((sum, item) => sum + item.value, 0);' }],
        },
        {
            type: 'taskList',
            content: [
                { type: 'taskItem', attrs: { checked: true }, content: [paragraph('Collect the numbers')] },
                { type: 'taskItem', attrs: { checked: false }, content: [paragraph('Publish the report')] },
            ],
        },
        { type: 'blockquote', content: [paragraph('Growth is compounding.')] },
        bulletList(['North', 'South', 'East']),
        table(
            ['Region', 'Total'],
            [
                ['North', '48'],
                ['South', '65'],
            ],
        ),
        {
            // Hostile content: a literal script string plus a blocked link scheme.
            type: 'paragraph',
            content: [
                { type: 'text', text: GOLDEN_DOC_XSS },
                {
                    type: 'text',
                    marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }],
                    text: 'click me',
                },
            ],
        },
    ];

    for (let i = 1; i <= 11; i++) {
        content.push(paragraph(`Section ${i} — recurring text.`));
    }
    // Past the 20-block preview cap: present in exports, absent from previews.
    for (let i = 1; i <= 4; i++) {
        content.push(paragraph(`${GOLDEN_BEYOND_CAP} ${i}`));
    }

    return { type: 'doc', content };
}

const HEAVY_SENTENCE = 'Revenue held across every region while costs stayed flat, so the margin picture is unchanged.';

// Each section is a heading + a marked-up paragraph, with a code block, a list and a
// table folded in on a fixed cadence — the node mix the renderers pay most for
// (lowlight highlighting, nested list/table walks), repeated `sections` times.
export function buildHeavyDocJson(sections = 300): JSONContent {
    const content: JSONContent[] = [];
    for (let i = 1; i <= sections; i++) {
        content.push({
            type: 'heading',
            attrs: { level: (i % 3) + 1 },
            content: [{ type: 'text', text: `Section ${i}` }],
        });
        content.push({
            type: 'paragraph',
            content: [
                { type: 'text', text: `${HEAVY_SENTENCE} Entry ${i} is ` },
                { type: 'text', marks: [{ type: 'bold' }], text: 'material' },
                { type: 'text', text: ' and ' },
                { type: 'text', marks: [{ type: 'italic' }], text: 'reviewed' },
                { type: 'text', text: ', see the ' },
                {
                    type: 'text',
                    marks: [{ type: 'link', attrs: { href: `${GOLDEN_DOC_LINK}/${i}` } }],
                    text: 'appendix',
                },
                { type: 'text', text: `. ${HEAVY_SENTENCE}` },
            ],
        });
        if (i % 4 === 0) {
            content.push({
                type: 'codeBlock',
                attrs: { language: 'javascript' },
                content: [
                    {
                        type: 'text',
                        text: `const total${i} = rows.filter((row) => row.region === 'North').reduce((sum, row) => sum + row.value, 0);`,
                    },
                ],
            });
        }
        if (i % 5 === 0) {
            content.push(bulletList(['North', 'South', 'East', 'West'].map((region) => `${region} ${i}`)));
        }
        if (i % 10 === 0) {
            content.push(
                table(
                    ['Region', 'Total'],
                    ['North', 'South', 'East'].map((region, row) => [region, String(i * 10 + row)]),
                ),
            );
        }
    }
    return { type: 'doc', content };
}

export function seedEigendoc(doc: Y.Doc, json: JSONContent): void {
    writeEigendocToYjs(doc, json, docSchema);
}

// A deck is a canvas of frames: one frame per slide, its elements storing frame-relative
// coordinates. The two stored fills come from the lib codec rather than hand-written JSON, so a
// codec change moves the fixture with it.
const TRANSPARENT_FILL_JSON = serializeFill(TRANSPARENT_FILL);
const SOLID_FILL_JSON = serializeFill({ type: 'solid', color: '#eef2ff', style: 'solid' });

function deckFrame(id: string, index: string, background: BackgroundFill | null): VectorFrame {
    return {
        id,
        index,
        name: '',
        width: FRAME_WIDTH,
        height: FRAME_HEIGHT,
        background: serializeBackgroundFill(background),
    };
}

function deckText(
    id: string,
    frameId: string,
    index: string,
    over: Partial<VectorRichTextElement>,
): VectorRichTextElement {
    return {
        ...DEFAULT_ELEMENT_PROPS,
        ...DEFAULT_RICHTEXT_PROPS,
        id,
        type: 'richtext',
        index,
        frameId,
        x: 160,
        y: 120,
        width: 1600,
        height: 400,
        angle: 0,
        strokeColor: 'transparent',
        html: '<p>Slide</p>',
        fill: TRANSPARENT_FILL_JSON,
        corners: 'curved',
        fontFamily: 'Inter',
        fontSize: 64,
        color: '#101010',
        ...over,
    };
}

// 10 frames: the first four carry the fixture's variety (gradient background + big bold title, an
// image element, an image background, hostile content on a bare frame) and the rest pad past the
// preview's 8-page cap so the truncation marker has something to truncate.
export function buildGoldenDeckScene(): VectorScene {
    const frames: VectorFrame[] = [];
    const elements: VectorElement[] = [];
    const keys = generateNKeysBetween(null, null, 10);

    frames.push(deckFrame('frame-1', keys[0], { type: 'gradient', from: '#ffffff', to: '#dbe7ff', angle: 45 }));
    elements.push(
        deckText('el-1', 'frame-1', keys[0], {
            html: '<p>Deck <strong>title</strong></p>',
            fontSize: 96,
            fontWeight: 'bold',
            textAlign: 'center',
            verticalAlign: 'center',
        }),
    );

    frames.push(deckFrame('frame-2', keys[1], { type: 'solid', color: '#f5f5f5' }));
    elements.push({
        ...DEFAULT_ELEMENT_PROPS,
        id: 'el-2',
        type: 'image',
        index: keys[1],
        frameId: 'frame-2',
        x: 320,
        y: 200,
        width: 640,
        height: 360,
        angle: 0,
        strokeColor: '#1a5fb4',
        strokeWidth: 4,
        mediaName: GOLDEN_MEDIA_NAME,
        objectFit: 'contain',
        corners: 'round',
    });

    frames.push(deckFrame('frame-3', keys[2], { type: 'image', mediaName: GOLDEN_MEDIA_NAME, fit: 'cover' }));
    elements.push(deckText('el-3', 'frame-3', keys[2], { html: '<p>Background image</p>', color: '#ffffff' }));

    // Hostile content: an injected script inside a rich-text body.
    frames.push(deckFrame('frame-4', keys[3], null));
    elements.push(deckText('el-4', 'frame-4', keys[3], { html: GOLDEN_DECK_XSS }));

    for (let i = 5; i <= 10; i++) {
        const beyond = i > 8 ? ` ${GOLDEN_BEYOND_CAP}` : '';
        frames.push(deckFrame(`frame-${i}`, keys[i - 1], { type: 'solid', color: '#ffffff' }));
        elements.push(
            deckText(`el-${i}`, `frame-${i}`, keys[i - 1], {
                html: `<p>Slide ${i}${beyond}</p>`,
                fill: SOLID_FILL_JSON,
                angle: i === 5 ? 15 : 0,
            }),
        );
    }

    return { elements, frames, meta: { background: 'transparent' } };
}

// Rich text only — no media, so the deck renders without a seeded media/ folder. Every frame carries
// a title plus body elements laid out in a fixed grid.
export function buildHeavyDeckScene(frameCount = 60, elementsPerFrame = 6): VectorScene {
    const frames: VectorFrame[] = [];
    const elements: VectorElement[] = [];
    const keys = generateNKeysBetween(null, null, frameCount * elementsPerFrame);
    for (let f = 1; f <= frameCount; f++) {
        const frameId = `heavy-frame-${f}`;
        frames.push(
            deckFrame(frameId, keys[(f - 1) * elementsPerFrame], {
                type: 'gradient',
                from: '#ffffff',
                to: '#dbe7ff',
                angle: 45,
            }),
        );
        for (let o = 0; o < elementsPerFrame; o++) {
            elements.push(
                deckText(`heavy-el-${f}-${o}`, frameId, keys[(f - 1) * elementsPerFrame + o], {
                    x: 160 + (o % 2) * 880,
                    y: 120 + Math.floor(o / 2) * 300,
                    width: 800,
                    height: 260,
                    html:
                        o === 0
                            ? `<p>Slide ${f} — <strong>heavy deck</strong></p>`
                            : `<p>${HEAVY_SENTENCE} Point ${o} of slide ${f}.</p>`,
                    fontSize: o === 0 ? 96 : 40,
                    fontWeight: o === 0 ? 'bold' : 'normal',
                    fill: o % 3 === 0 ? SOLID_FILL_JSON : TRANSPARENT_FILL_JSON,
                }),
            );
        }
    }
    return { elements, frames, meta: { background: 'transparent' } };
}

// A follow-up edit in its own transaction, the way an editor session writes one, so
// data.db carries a real update-row history instead of a single consolidated blob.
export function editGoldenDeckTitle(doc: Y.Doc, text: string): void {
    doc.transact(() => {
        const title = doc.getMap('elements').get('el-1');
        if (title instanceof Y.Map) title.set('html', `<p>${text}</p>`);
    });
}

// Media lives in the container's media/ folder, exactly where a real upload lands.
export async function seedDocumentMedia(
    mount: Mount,
    drivePath: DrivePath,
    name: string,
    bytes: Uint8Array,
    mimeType = 'image/png',
): Promise<void> {
    const mediaFolder = await mount.getChildByName(drivePath.id, 'media');
    if (!mediaFolder) throw new Error(`${drivePath.name}: media folder missing`);
    await mount.createFile(mediaFolder.id, name, mimeType, bytes.byteLength, bytes);
}

// Deterministic eigenvector fixture for the transform work (preview round-trip and
// search extraction). Mirrors the deck fixture idiom: literal fields, fixed seeds and
// fractional indices, one media reference, one rich-text box plus a bound arrow with a
// label — the two sources the extractor joins. Every type the serializer special-cases
// appears once (shape, ellipse, rich text, freedraw, line, bound labelled arrow, image).
export const GOLDEN_VECTOR_TEXT = 'Vector <sketch>';
export const GOLDEN_VECTOR_LABEL = 'Bound label';

export function buildGoldenVectorScene(): VectorScene {
    const base = { ...DEFAULT_ELEMENT_PROPS, angle: 0 };
    // The fill codec's transparent solid — what every element painted before `fill` existed.
    const filled = { fill: solidFill('transparent') } as const;
    const elements: VectorElement[] = [
        {
            ...base,
            ...filled,
            ...DEFAULT_SKETCH_PROPS,
            id: 'v-rect',
            type: 'rectangle',
            x: 0,
            y: 0,
            width: 100,
            height: 60,
            seed: 1,
            index: 'a0',
            corners: 'straight',
        },
        {
            ...base,
            ...filled,
            ...DEFAULT_SKETCH_PROPS,
            id: 'v-ellipse',
            type: 'ellipse',
            x: 140,
            y: 0,
            width: 80,
            height: 80,
            seed: 2,
            index: 'a1',
        },
        {
            ...base,
            ...filled,
            id: 'v-text',
            type: 'richtext',
            x: 0,
            y: 100,
            width: 160,
            height: 50,
            index: 'a2',
            // The XSS payload rides in as escaped markup, the way the editor stores it: the
            // search collector must strip the <p> back off and the export must keep it escaped.
            html: `<p>${escapeHtml(GOLDEN_VECTOR_TEXT)}</p>`,
            corners: 'straight',
            fontSize: 20,
            fontFamily: 'Excalifont',
            fontWeight: 'normal',
            fontStyle: 'normal',
            textDecoration: 'none',
            textAlign: 'left',
            verticalAlign: 'top',
            color: '#1e1e1e',
            letterSpacing: 0,
            lineHeight: 1.2,
            padding: 0,
        },
        {
            ...base,
            ...filled,
            ...DEFAULT_SKETCH_PROPS,
            id: 'v-freedraw',
            type: 'freedraw',
            x: 0,
            y: 180,
            width: 60,
            height: 20,
            seed: 4,
            index: 'a3',
            roundness: 'sharp',
            points: '[[0,0],[15,10],[30,4],[45,18],[60,8]]',
            pressures: '',
            simulatePressure: true,
        },
        {
            ...base,
            ...filled,
            ...DEFAULT_SKETCH_PROPS,
            id: 'v-line',
            type: 'line',
            x: 140,
            y: 180,
            width: 100,
            height: 40,
            seed: 5,
            index: 'a4',
            roundness: 'sharp',
            points: '[[0,0],[100,0],[100,40]]',
            pressures: '',
            simulatePressure: true,
        },
        {
            ...base,
            ...DEFAULT_SKETCH_PROPS,
            id: 'v-arrow',
            type: 'arrow',
            elbow: false,
            fixedSegments: '',
            x: 0,
            y: 260,
            width: 120,
            height: 0,
            seed: 6,
            index: 'a5',
            roundness: 'sharp',
            points: '[[0,0],[120,0]]',
            startArrowhead: 'none',
            endArrowhead: 'triangle',
            startBinding: '{"elementId":"v-rect","fixedPoint":[1,0.5]}',
            endBinding: '{"elementId":"v-ellipse","fixedPoint":[0,0.5]}',
            text: GOLDEN_VECTOR_LABEL,
            fontSize: 20,
            fontFamily: 'Excalifont',
            labelWidth: 90,
        },
        {
            ...base,
            id: 'v-image',
            type: 'image',
            x: 0,
            y: 340,
            width: 120,
            height: 120,
            index: 'a6',
            mediaName: GOLDEN_MEDIA_NAME,
            corners: 'round',
            objectFit: 'contain',
        },
        // A bound elbow arrow (no label) — its orthogonal route is DERIVED at render time, so preview
        // and export exercise the server-side elbowRoute path end-to-end.
        {
            ...base,
            ...DEFAULT_SKETCH_PROPS,
            id: 'v-elbow',
            type: 'arrow',
            elbow: true,
            fixedSegments: '',
            x: 50,
            y: 66,
            width: 130,
            height: 20,
            seed: 8,
            index: 'a7',
            roundness: 'sharp',
            points: '[[0,0],[130,20]]',
            startArrowhead: 'none',
            endArrowhead: 'arrow',
            startBinding: '{"elementId":"v-rect","fixedPoint":[0.5,1]}',
            endBinding: '{"elementId":"v-ellipse","fixedPoint":[0.5,1]}',
            text: '',
            fontSize: 20,
            fontFamily: 'Excalifont',
            labelWidth: 0,
        },
        // A gradient fill painted through the hachure sketch: phase 0 proved WeasyPrint honours an
        // SVG linearGradient as `stroke=` on the fill-sketch paths, but ONLY when the <defs> lives
        // inside the element's own <svg>. The export golden is what keeps that true.
        {
            ...base,
            ...DEFAULT_SKETCH_PROPS,
            id: 'v-gradient',
            type: 'rectangle',
            x: 260,
            y: 340,
            width: 120,
            height: 80,
            seed: 9,
            index: 'a8',
            corners: 'curved',
            fill: serializeFill({ type: 'gradient', from: '#e60076', to: '#2563eb', angle: 45, style: 'hachure' }),
        },
    ];
    return { elements, frames: [], meta: { background: 'transparent' } };
}

// Write a VectorScene into a Y.Doc the way use-canvas-doc.ts persists one: a per-element Y.Map under
// `elements`, a per-frame Y.Map under `frames`, and the `meta` root. read-vector reads only the
// whitelisted keys, so setting every own field is safe.
export function seedVectorDoc(doc: Y.Doc, scene: VectorScene): void {
    doc.transact(() => {
        const elementsMap = doc.getMap('elements');
        const framesMap = doc.getMap('frames');
        const metaMap = doc.getMap('meta');
        for (const element of scene.elements) {
            const yElement = new Y.Map<unknown>();
            for (const [field, value] of Object.entries(element)) yElement.set(field, value);
            elementsMap.set(element.id, yElement);
        }
        for (const frame of scene.frames) {
            const yFrame = new Y.Map<unknown>();
            // width/height are constants, never stored — FRAME_FIELDS is the allow-list.
            for (const field of FRAME_FIELDS) yFrame.set(field, frameField(frame, field));
            framesMap.set(frame.id, yFrame);
        }
        metaMap.set('background', scene.meta.background);
    });
}

function frameField(frame: VectorFrame, field: string): string {
    switch (field) {
        case 'id':
            return frame.id;
        case 'index':
            return frame.index;
        case 'name':
            return frame.name;
        case 'background':
            return frame.background;
        default:
            throw new Error(`unknown frame field: ${field}`);
    }
}

// A deck and a drawing are the same document; the alias keeps the call sites readable.
export const seedDeckDoc = seedVectorDoc;
