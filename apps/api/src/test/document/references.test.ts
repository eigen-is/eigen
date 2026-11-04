import { describe, expect, spyOn, test } from 'bun:test';
import type { Op, Sheet, SheetImage } from '@workspace/lib/sheets';
import { encodeSheetsSnapshot, writeSheetsSnapshot } from '@workspace/lib/sheets';
import { DRIVE_MIME_DOC, DRIVE_TYPE_DOC } from '@workspace/lib/types/drive';
import type { AttachmentReference } from '@workspace/lib/types/drive-reference';
import type { VectorScene } from '@workspace/lib/vector';
import { serializeBackgroundFill } from '@workspace/lib/vector';
import { writeMathml } from '@workspace/math';
import * as Y from 'yjs';
import type { YjsStatePayload } from '../../lib/collab/yjs-loader';
import { ApiError } from '../../lib/core/errors';
import { documentReferences } from '../../lib/document/references';
import { toTransferableBuffer } from '../../lib/document/transform/protocol';
import { runDocumentReferences, TransformFailedError } from '../../lib/document/transform/run-transform';
import { documentTransformRunner } from '../../lib/document/transform/runner';
import type { DocumentReferences } from '../../lib/mount/schema';
import { MAX_DECOMPRESSED_BYTES } from '../../lib/ooxml/zip';
import {
    buildGoldenDeckScene,
    GOLDEN_MEDIA_NAME,
    seedBand,
    seedEigendoc,
    seedVectorDoc,
} from '../fixtures/golden-documents';

// A container document attached to a card names a Drive id, never a file in media/.
const DRIVE_DOCUMENT: AttachmentReference = {
    type: 'reference',
    ownerId: 'u1',
    mountId: 'default',
    id: 'path-1',
    name: 'Plan.eigendoc',
    driveType: DRIVE_TYPE_DOC,
    mimeType: DRIVE_MIME_DOC,
};

// A card as the comment hooks write it: a Y.Map in the host's card map, its attachments a plain list.
function addCard(
    doc: Y.Doc,
    mapName: 'comments' | 'tasks',
    id: string,
    fields: { chatName?: string; attachments?: unknown[]; deletedAt?: number } = {},
): void {
    const card = new Y.Map<unknown>();
    card.set('id', id);
    card.set('title', id);
    card.set('description', '');
    for (const [field, value] of Object.entries(fields)) card.set(field, value);
    doc.getMap(mapName).set(id, card);
}

const sorted = (references: DocumentReferences): DocumentReferences => ({
    media: [...references.media].sort(),
    chat: [...references.chat].sort(),
});

const paragraph = (...content: object[]) => ({ type: 'paragraph', content });
const figure = (mediaName: string, commentCardId: string | null = null) => ({
    type: 'figure',
    attrs: { mediaName, commentCardId },
});

function buildDoc(): Y.Doc {
    const doc = new Y.Doc();
    seedEigendoc(doc, {
        type: 'doc',
        content: [
            paragraph(
                { type: 'text', text: 'Marked', marks: [{ type: 'comment', attrs: { cardId: 'c-mark' } }] },
                figure('body.png', 'c-figure'),
                { type: 'chart', attrs: { commentCardId: 'c-chart' } },
                {
                    type: 'equation',
                    attrs: { mathml: writeMathml([{ kind: 'identifier', text: 'x' }]), commentCardId: 'c-equation' },
                },
            ),
            paragraph({
                type: 'textBox',
                attrs: { commentCardId: 'c-box' },
                content: [paragraph({ type: 'text', text: 'In a box' })],
            }),
        ],
    });
    seedBand(doc, 'header', paragraph(figure('header.png')));
    // A first-page band prints only while page 1 differs, but turning that back on shows it again.
    seedBand(doc, 'footerFirst', paragraph(figure('first-footer.png', 'c-band')));
    addCard(doc, 'comments', 'c-mark', { chatName: 'thread-mark', attachments: ['card.pdf', DRIVE_DOCUMENT] });
    for (const id of ['c-figure', 'c-chart', 'c-equation', 'c-box', 'c-band']) {
        addCard(doc, 'comments', id, { chatName: `thread-${id}` });
    }
    addCard(doc, 'comments', 'c-loose', { chatName: 'thread-loose', attachments: ['loose.pdf'] });
    return doc;
}

function buildCanvas(): Y.Doc {
    const golden = buildGoldenDeckScene();
    const scene: VectorScene = {
        ...golden,
        frames: golden.frames.map((frame) =>
            frame.id === 'frame-3'
                ? {
                      ...frame,
                      background: serializeBackgroundFill({ type: 'image', mediaName: 'background.png', fit: 'cover' }),
                  }
                : frame,
        ),
        elements: golden.elements.map((el) =>
            el.id === 'el-1' ? { ...el, commentCardIds: JSON.stringify(['c-anchored', 'c-deleted-anchored']) } : el,
        ),
    };
    const doc = new Y.Doc();
    seedVectorDoc(doc, scene);
    addCard(doc, 'comments', 'c-anchored', { chatName: 'thread-anchored', attachments: ['anchored.pdf'] });
    addCard(doc, 'comments', 'c-document', { chatName: 'thread-document', attachments: [DRIVE_DOCUMENT] });
    // An undo or a restore that brings the anchor back brings its deleted card back.
    addCard(doc, 'comments', 'c-deleted-anchored', { chatName: 'thread-deleted-anchored', deletedAt: 1 });
    addCard(doc, 'comments', 'c-deleted', { chatName: 'thread-deleted', attachments: ['deleted.pdf'], deletedAt: 1 });
    return doc;
}

const image = (id: string, mediaName: string): SheetImage => ({
    id,
    index: 'a0',
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    mediaName,
});

function buildSheets(): Y.Doc {
    const sheets: Sheet[] = [
        {
            id: 's1',
            name: 'One',
            order: 0,
            celldata: [{ r: 0, c: 0, v: { v: 'a', m: 'a', commentCardIds: ['c-snapshot'] } }],
            images: { i1: image('i1', 'snapshot.png') },
        },
        {
            id: 's2',
            name: 'Two',
            order: 1,
            celldata: [{ r: 1, c: 1, v: { v: 'b', m: 'b', commentCardIds: ['c-tab-two'] } }],
            images: { i2: image('i2', 'tab-two.png') },
        },
    ];
    const added: Sheet = {
        id: 's3',
        name: 'Three',
        order: 2,
        data: [[{ v: 'c', commentCardIds: ['c-added-sheet'] }]],
        images: { i4: image('i4', 'added-sheet.png') },
    };
    // The ops a tab sent since the last compaction: a new image, a renamed upload, a comment on a cell, a card added to a
    // cell's list, and a whole new tab.
    const batches: Op[][] = [
        [{ op: 'add', id: 's2', path: ['images', 'i3'], value: image('i3', 'op.png') }],
        [{ op: 'replace', id: 's1', path: ['images', 'i1', 'mediaName'], value: 'renamed.png' }],
        [{ op: 'replace', id: 's1', path: ['data', 3, 4, 'commentCardIds'], value: ['c-op'] }],
        [{ op: 'add', id: 's2', path: ['data', 1, 1, 'commentCardIds', 1], value: 'c-op-index' }],
        [{ op: 'addSheet', id: 's3', path: [], value: added }],
    ];
    const doc = new Y.Doc();
    writeSheetsSnapshot(doc, encodeSheetsSnapshot(sheets, { computed: true }), null);
    for (const batch of batches) doc.getArray<Op[]>('ops').push([batch]);
    for (const id of ['c-snapshot', 'c-tab-two', 'c-op', 'c-op-index', 'c-added-sheet']) {
        addCard(doc, 'comments', id, { chatName: `thread-${id}` });
    }
    addCard(doc, 'comments', 'c-snapshot', { chatName: 'thread-c-snapshot', attachments: ['cell.pdf'] });
    addCard(doc, 'comments', 'c-loose', { chatName: 'thread-loose', attachments: ['loose.pdf'] });
    return doc;
}

function buildStickies(): Y.Doc {
    const doc = new Y.Doc();
    addCard(doc, 'tasks', 'on-board', { chatName: 'thread-on-board', attachments: ['note.pdf', DRIVE_DOCUMENT] });
    addCard(doc, 'tasks', 'off-board', { chatName: 'thread-off-board', attachments: ['off-board.pdf'] });
    const column = new Y.Map<unknown>();
    column.set('title', 'To do');
    column.set('taskIds', Y.Array.from(['on-board']));
    doc.getMap('columns').set('c1', column);
    doc.getArray<string>('columnOrder').push(['c1']);
    return doc;
}

describe('documentReferences', () => {
    test('a doc names the figures of its body and every band, and the threads and files of the cards it anchors', () => {
        expect(sorted(documentReferences('doc', buildDoc()))).toEqual({
            media: ['body.png', 'card.pdf', 'first-footer.png', 'header.png'],
            chat: [
                'thread-c-band',
                'thread-c-box',
                'thread-c-chart',
                'thread-c-equation',
                'thread-c-figure',
                'thread-mark',
            ],
        });
    });

    test.each(['slides', 'vector'] as const)(
        '%s names its images, frame pictures and the cards it anchors or has not deleted',
        (type) => {
            expect(sorted(documentReferences(type, buildCanvas()))).toEqual({
                media: ['anchored.pdf', 'background.png', GOLDEN_MEDIA_NAME],
                chat: ['thread-anchored', 'thread-deleted-anchored', 'thread-document'],
            });
        },
    );

    test('a workbook names the images and cell comments of every tab, in its snapshot and in its pending ops', () => {
        expect(sorted(documentReferences('sheets', buildSheets()))).toEqual({
            media: ['added-sheet.png', 'cell.pdf', 'op.png', 'renamed.png', 'snapshot.png', 'tab-two.png'],
            chat: ['thread-c-added-sheet', 'thread-c-op', 'thread-c-op-index', 'thread-c-snapshot', 'thread-c-tab-two'],
        });
    });

    test('a board names the threads and files of the cards on it', () => {
        expect(sorted(documentReferences('stickies', buildStickies()))).toEqual({
            media: ['note.pdf'],
            chat: ['thread-on-board'],
        });
    });

    test('a doc names the figure and the comment of a footnote', () => {
        const doc = new Y.Doc();
        const note = {
            type: 'footnote',
            attrs: { id: 'note-1' },
            content: [
                paragraph(figure('note.png'), {
                    type: 'text',
                    text: 'Noted',
                    marks: [{ type: 'comment', attrs: { cardId: 'c-note' } }],
                }),
            ],
        };
        seedEigendoc(doc, { type: 'doc', content: [paragraph({ type: 'text', text: 'Body' }, note)] });
        addCard(doc, 'comments', 'c-note', { chatName: 'thread-note' });
        expect(sorted(documentReferences('doc', doc))).toEqual({ media: ['note.png'], chat: ['thread-note'] });
    });

    test('a pending op that writes a whole cell or a whole row names its comments, and a remove names nothing', () => {
        const doc = new Y.Doc();
        const sheets: Sheet[] = [{ id: 's1', name: 'One', order: 0, celldata: [] }];
        writeSheetsSnapshot(doc, encodeSheetsSnapshot(sheets, { computed: true }), null);
        const batches: Op[][] = [
            [{ op: 'replace', id: 's1', path: ['data', 2, 3], value: { v: 'a', commentCardIds: ['c-cell'] } }],
            [{ op: 'replace', id: 's1', path: ['data', 4], value: [null, { v: 'b', commentCardIds: ['c-row'] }] }],
            [{ op: 'remove', id: 's1', path: ['images', 'i1'] }],
        ];
        for (const batch of batches) doc.getArray<Op[]>('ops').push([batch]);
        for (const id of ['c-cell', 'c-row']) addCard(doc, 'comments', id, { chatName: `thread-${id}` });
        expect(sorted(documentReferences('sheets', doc))).toEqual({
            media: [],
            chat: ['thread-c-cell', 'thread-c-row'],
        });
    });

    test('a card whose id is a property of every object is still a card', () => {
        const doc = new Y.Doc();
        seedEigendoc(doc, {
            type: 'doc',
            content: [
                paragraph({ type: 'text', text: 'Odd', marks: [{ type: 'comment', attrs: { cardId: '__proto__' } }] }),
            ],
        });
        addCard(doc, 'comments', '__proto__', { chatName: 'thread-proto', attachments: ['proto.pdf'] });
        expect(sorted(documentReferences('doc', doc))).toEqual({ media: ['proto.pdf'], chat: ['thread-proto'] });
    });

    test('a card it cannot read throws, so a sweep keeps every thread', () => {
        const doc = buildDoc();
        doc.getMap('comments').set('c-garbage', 'not a card');
        expect(() => documentReferences('doc', doc)).toThrow();
    });

    test('a deleted mark that is no time throws', () => {
        const doc = buildCanvas();
        addCard(doc, 'comments', 'c-odd', { chatName: 'thread-odd' });
        doc.getMap<Y.Map<unknown>>('comments').get('c-odd')?.set('deletedAt', 'yesterday');
        expect(() => documentReferences('vector', doc)).toThrow();
    });

    test('an attachment it cannot read throws', () => {
        const doc = buildStickies();
        addCard(doc, 'tasks', 'on-board', { attachments: [42] });
        expect(() => documentReferences('stickies', doc)).toThrow();
    });

    test('a workbook snapshot or op batch it cannot read throws', () => {
        const snapshot = buildSheets();
        snapshot.getMap('state').set('snapshot', '{"f":"eigensheets/0"}');
        expect(() => documentReferences('sheets', snapshot)).toThrow();

        const ops = buildSheets();
        ops.getArray<unknown>('ops').push(['not a batch']);
        expect(() => documentReferences('sheets', ops)).toThrow();
    });
});

const payloadOf = (doc: Y.Doc): YjsStatePayload => ({
    snapshot: null,
    updates: [{ id: 1, data: toTransferableBuffer(Y.encodeStateAsUpdate(doc)) }],
});

describe('runDocumentReferences', () => {
    test("one job reads each document in the transform process and answers each one's references in order", async () => {
        const references = await runDocumentReferences(
            [
                { documentType: 'stickies', source: payloadOf(buildStickies()) },
                { documentType: 'doc', source: payloadOf(buildDoc()) },
            ],
            {},
        );
        expect(references.map(sorted)).toEqual([
            sorted(documentReferences('stickies', buildStickies())),
            sorted(documentReferences('doc', buildDoc())),
        ]);
    });

    test('a blob it cannot read fails the job, as a name in it would be missed', async () => {
        const corrupt: YjsStatePayload = {
            snapshot: null,
            updates: [{ id: 1, data: toTransferableBuffer(new Uint8Array([255, 1, 2, 3, 4, 5])) }],
        };
        await expect(runDocumentReferences([{ documentType: 'doc', source: corrupt }], {})).rejects.toBeInstanceOf(
            TransformFailedError,
        );
    });

    test('documents past the copy cap are refused before a child runs', async () => {
        const run = spyOn(documentTransformRunner, 'run');
        try {
            const huge: YjsStatePayload = {
                snapshot: null,
                updates: [{ id: 1, data: new ArrayBuffer(MAX_DECOMPRESSED_BYTES + 1) }],
            };
            const refused = runDocumentReferences([{ documentType: 'doc', source: huge }], {});
            await expect(refused).rejects.toBeInstanceOf(ApiError);
            await expect(refused).rejects.toMatchObject({ status: 413 });
            expect(run).not.toHaveBeenCalled();
        } finally {
            run.mockRestore();
        }
    });
});
