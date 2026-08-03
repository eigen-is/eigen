import type { JSONContent } from '@tiptap/core';
import { getSchema } from '@tiptap/core';
import { getDocExtensions } from '@workspace/lib/docs/eigendoc';
import type { DeckData, ImageObject, TextObject } from '@workspace/lib/slides';
import type { BackgroundFill } from '@workspace/lib/types/background';
import type { DrivePath } from '@workspace/lib/types/drive';
import { common, createLowlight } from 'lowlight';
import * as Y from 'yjs';
import { writeEigendocToYjs } from '../../lib/document/doc';
import type { Mount } from '../../lib/mount';

// Deterministic eigendoc + eigenslides fixtures for the document-transform work
// (preview/export golden tests). Everything is literal — no randomness, no clock —
// so rendered output is byte-stable across runs and the golden hashes in
// document-transform.test.ts stay valid.
//
// Both fixtures are deliberately over the preview cap (24 blocks / 10 slides) and
// carry one media reference, hostile strings the sanitizer must defang, and the
// node/object variants each renderer special-cases.

export const GOLDEN_MEDIA_NAME = 'pixel.png';
export const GOLDEN_BEYOND_CAP = 'BEYOND-PREVIEW-CAP';
export const GOLDEN_DOC_XSS = '<script>alert("doc-xss")</script>';
export const GOLDEN_DECK_XSS = '<p>legit body</p><script>alert("deck-xss")</script>';
export const GOLDEN_DOC_LINK = 'https://example.com/report';

// The lowlight instance the doc renderers use — the schema must match, or a
// codeBlock node cannot be written into the Yjs document.
const docSchema = getSchema(getDocExtensions({ lowlight: createLowlight(common) }));

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
                {
                    type: 'taskItem',
                    attrs: { checked: true },
                    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Collect the numbers' }] }],
                },
                {
                    type: 'taskItem',
                    attrs: { checked: false },
                    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Publish the report' }] }],
                },
            ],
        },
        {
            type: 'blockquote',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Growth is compounding.' }] }],
        },
        {
            type: 'bulletList',
            content: ['North', 'South', 'East'].map((region) => ({
                type: 'listItem',
                content: [{ type: 'paragraph', content: [{ type: 'text', text: region }] }],
            })),
        },
        {
            type: 'table',
            content: [
                {
                    type: 'tableRow',
                    content: ['Region', 'Total'].map((label) => ({
                        type: 'tableHeader',
                        content: [{ type: 'paragraph', content: [{ type: 'text', text: label }] }],
                    })),
                },
                ...[
                    ['North', '48'],
                    ['South', '65'],
                ].map((cells) => ({
                    type: 'tableRow',
                    content: cells.map((cell) => ({
                        type: 'tableCell',
                        content: [{ type: 'paragraph', content: [{ type: 'text', text: cell }] }],
                    })),
                })),
            ],
        },
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
        content.push({ type: 'paragraph', content: [{ type: 'text', text: `Section ${i} — recurring text.` }] });
    }
    // Past the 20-block preview cap: present in exports, absent from previews.
    for (let i = 1; i <= 4; i++) {
        content.push({ type: 'paragraph', content: [{ type: 'text', text: `${GOLDEN_BEYOND_CAP} ${i}` }] });
    }

    return { type: 'doc', content };
}

export function seedEigendoc(doc: Y.Doc, json: JSONContent): void {
    writeEigendocToYjs(doc, json, docSchema);
}

// A follow-up edit in its own transaction, the way an editor session writes one, so
// data.db carries a real update-row history instead of a single consolidated blob.
export function appendGoldenDocParagraph(doc: Y.Doc, text: string): void {
    doc.transact(() => {
        const paragraph = new Y.XmlElement('paragraph');
        paragraph.insert(0, [new Y.XmlText(text)]);
        doc.getXmlFragment('default').push([paragraph]);
    });
}

function textObject(id: string, slideId: string, overrides: Partial<TextObject>): TextObject {
    return {
        id,
        slideId,
        type: 'text',
        x: 160,
        y: 120,
        w: 1600,
        h: 400,
        rotation: 0,
        borderColor: '',
        borderWidth: 0,
        borderRadius: 0,
        commentCardIds: [],
        text: '<p>Slide</p>',
        fontFamily: 'Inter',
        fontSize: 64,
        fontWeight: 'normal',
        fontStyle: 'normal',
        textDecoration: 'none',
        textAlign: 'left',
        verticalAlign: 'top',
        color: '#101010',
        letterSpacing: 0,
        lineHeight: 1.2,
        highlightColor: '',
        background: null,
        ...overrides,
    };
}

function imageObject(id: string, slideId: string): ImageObject {
    return {
        id,
        slideId,
        type: 'image',
        x: 320,
        y: 200,
        w: 640,
        h: 360,
        rotation: 0,
        borderColor: '#1a5fb4',
        borderWidth: 4,
        borderRadius: 12,
        commentCardIds: [],
        mediaName: GOLDEN_MEDIA_NAME,
        objectFit: 'contain',
    };
}

export function buildGoldenDeck(): DeckData {
    const deck: DeckData = { slides: {}, objects: {}, slideOrder: [] };

    const add = (slideId: string, background: BackgroundFill | null, objects: (TextObject | ImageObject)[]) => {
        for (const object of objects) deck.objects[object.id] = object;
        deck.slides[slideId] = { id: slideId, objectIds: objects.map((object) => object.id), background };
        deck.slideOrder.push(slideId);
    };

    add('slide-1', { type: 'gradient', from: '#ffffff', to: '#dbe7ff', angle: 45 }, [
        textObject('obj-1', 'slide-1', {
            text: '<p>Deck <strong>title</strong></p>',
            fontSize: 96,
            fontWeight: 'bold',
            highlightColor: '#ffe08a',
            textAlign: 'center',
            verticalAlign: 'center',
        }),
    ]);
    add('slide-2', { type: 'solid', color: '#f5f5f5' }, [imageObject('obj-2', 'slide-2')]);
    add('slide-3', { type: 'image', mediaName: GOLDEN_MEDIA_NAME, fit: 'cover' }, [
        textObject('obj-3', 'slide-3', { text: '<p>Background image</p>', color: '#ffffff' }),
    ]);
    add('slide-4', null, [
        // Hostile content: an injected script and an attribute-breakout color.
        textObject('obj-4', 'slide-4', { text: GOLDEN_DECK_XSS, color: 'red;" onload="alert(1)' }),
    ]);
    for (let i = 5; i <= 10; i++) {
        const beyond = i > 8 ? ` ${GOLDEN_BEYOND_CAP}` : '';
        add(`slide-${i}`, { type: 'solid', color: '#ffffff' }, [
            textObject(`obj-${i}`, `slide-${i}`, {
                text: `<p>Slide ${i}${beyond}</p>`,
                background: { type: 'solid', color: '#eef2ff' },
                rotation: i === 5 ? 15 : 0,
            }),
        ]);
    }

    return deck;
}

export function seedSlidesDoc(doc: Y.Doc, deck: DeckData): void {
    doc.transact(() => {
        const slidesMap = doc.getMap('slides');
        const objectsMap = doc.getMap('objects');
        const slideOrder = doc.getArray<string>('slideOrder');

        for (const [objectId, object] of Object.entries(deck.objects)) {
            const yObject = new Y.Map<unknown>();
            for (const [field, value] of Object.entries(object)) yObject.set(field, value);
            objectsMap.set(objectId, yObject);
        }
        for (const [slideId, slide] of Object.entries(deck.slides)) {
            const ySlide = new Y.Map<unknown>();
            ySlide.set('id', slide.id);
            ySlide.set('background', slide.background);
            const objectIds = new Y.Array<string>();
            objectIds.push(slide.objectIds);
            ySlide.set('objectIds', objectIds);
            slidesMap.set(slideId, ySlide);
        }
        slideOrder.push(deck.slideOrder);
    });
}

// A follow-up edit in its own transaction — the deck's equivalent of
// appendGoldenDocParagraph.
export function editGoldenDeckTitle(doc: Y.Doc, text: string): void {
    doc.transact(() => {
        const title = doc.getMap('objects').get('obj-1') as Y.Map<unknown>;
        title.set('text', `<p>${text}</p>`);
    });
}

// Media lives in the container's media/ folder, exactly where a real upload lands.
export async function seedDocumentMedia(
    mount: Mount,
    drivePath: DrivePath,
    name: string,
    bytes: Uint8Array,
): Promise<void> {
    const mediaFolder = await mount.getChildByName(drivePath.id, 'media');
    if (!mediaFolder) throw new Error(`${drivePath.name}: media folder missing`);
    await mount.createFile(mediaFolder.id, name, 'image/png', bytes.byteLength, bytes);
}
