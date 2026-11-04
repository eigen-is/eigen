// What the current state of a collab document names among its own parts: the files in its `media/` folder and the
// comment threads in its `chat/` folder. A later sweep deletes the parts nothing names, so a name a reader misses
// deletes a part in use. Each reader therefore errs on the side of more names, and throws on a shape it does not know,
// which the sweep takes as "delete nothing". The references job runs it in the transform process, on a materialized doc.

import { yXmlFragmentToProsemirrorJSON } from '@tiptap/y-tiptap';
import { boardCardIds, getItemMapRoot } from '@workspace/lib/collab/yjs-utils';
import { commentCardIdsIn } from '@workspace/lib/docs/eigendoc';
import { isRecord } from '@workspace/lib/guards';
import type { Cell, Op } from '@workspace/lib/sheets';
import { decodeSheetsSnapshot, readSheetsSnapshotJson, sheetsOpLog } from '@workspace/lib/sheets';
import type { CommentCard } from '@workspace/lib/types/comments';
import type { DRIVE_TYPE_CHAT, EigenDocType } from '@workspace/lib/types/drive';
import { EIGEN_DOC_TYPE_INFO } from '@workspace/lib/types/drive';
import { activeCommentCardIds, readVectorFromDoc } from '@workspace/lib/vector';
import * as Y from 'yjs';
import type { CollabDocumentType } from './collab-types';
import { mediaNamesIn, sceneMediaNames } from './media';

export type ReferencedDocumentType = CollabDocumentType | 'eigenstickies';
export type DocumentReferences = { media: string[]; chat: string[] };

// The reader each kind of collab document takes, by its Drive type.
export const REFERENCED_TYPE_BY_DRIVE_TYPE = {
    doc: 'eigendoc',
    sheets: 'eigensheets',
    slides: 'eigenslides',
    vector: 'eigenvector',
    stickies: 'eigenstickies',
} as const satisfies Record<Exclude<EigenDocType, typeof DRIVE_TYPE_CHAT>, ReferencedDocumentType>;

// Bump it whenever what any reader here finds changes.
export const REFERENCE_READER_VERSION = 1;

// The doc's body and its bands, and any other fragment the doc declares.
const DOC_FRAGMENTS = Object.entries(EIGEN_DOC_TYPE_INFO.doc.yjsRoots)
    .filter(([, kind]) => kind === 'xmlfragment')
    .map(([root]) => root);

// The field a cell keeps its comment cards in.
const CELL_ANCHOR = 'commentCardIds' satisfies keyof Cell;

// What a comment card names: its thread, and the files it attached by name. An attachment that is a Drive reference
// names a document elsewhere, not a file in media/.
type CardParts = Pick<CommentCard, 'id' | 'chatName' | 'deletedAt'> & { media: string[] };

// Only a card in use names its thread and its files, such as a card the content anchors, or on a canvas a card nobody
// deleted. The rules a client shares live in lib beside it, such as the canvas's and the board's.
export function documentReferences(type: ReferencedDocumentType, doc: Y.Doc): DocumentReferences {
    const cards = readCardParts(doc, type === 'eigenstickies' ? 'tasks' : 'comments');
    const { media, inUse } = contentReferences(type, doc, cards);
    const chat = new Set<string>();
    for (const id of inUse) {
        const card = cards.get(id);
        if (!card) continue;
        if (card.chatName) chat.add(card.chatName);
        for (const name of card.media) media.add(name);
    }
    return { media: [...media].sort(), chat: [...chat].sort() };
}

function contentReferences(
    type: ReferencedDocumentType,
    doc: Y.Doc,
    cards: ReadonlyMap<string, CardParts>,
): { media: Set<string>; inUse: Set<string> } {
    switch (type) {
        case 'eigendoc': {
            const fragments = DOC_FRAGMENTS.map((root) => yXmlFragmentToProsemirrorJSON(doc.getXmlFragment(root)));
            return { media: mediaNamesIn(fragments), inUse: commentCardIdsIn(fragments) };
        }
        case 'eigenslides':
        case 'eigenvector': {
            const scene = readVectorFromDoc(doc);
            return {
                media: sceneMediaNames(scene),
                inUse: activeCommentCardIds(scene.elements, Object.fromEntries(cards)),
            };
        }
        case 'eigensheets': {
            const sheets = sheetsAsStored(doc);
            return { media: mediaNamesIn(sheets), inUse: cellCardIds(sheets) };
        }
        case 'eigenstickies':
            return { media: new Set(), inUse: boardCardIds(doc) };
    }
}

// A card a peer wrote in a shape the editor never writes throws rather than drop the thread it may name.
function readCardParts(doc: Y.Doc, mapName: 'comments' | 'tasks'): Map<string, CardParts> {
    const cards = new Map<string, CardParts>();
    for (const [id, card] of getItemMapRoot(doc, mapName)) {
        if (!(card instanceof Y.Map)) throw new Error(`Unreadable comment card ${id}`);
        const chatName: unknown = card.get('chatName');
        const attachments: unknown = card.get('attachments') ?? [];
        const deletedAt: unknown = card.get('deletedAt');
        if ((chatName !== undefined && typeof chatName !== 'string') || !Array.isArray(attachments)) {
            throw new Error(`Unreadable comment card ${id}`);
        }
        const media: string[] = [];
        for (const attachment of attachments) {
            if (typeof attachment === 'string') media.push(attachment);
            else if (!isRecord(attachment)) throw new Error(`Unreadable attachment on comment card ${id}`);
        }
        cards.set(id, { id, chatName, media, deletedAt: typeof deletedAt === 'number' ? deletedAt : undefined });
    }
    return cards;
}

// The sheets the snapshot stores and every op still pending, read without a replay: an image or a comment an op
// removed stays named until the next compaction. An op that writes one field, such as an upload's final mediaName or
// one card id added to a cell's list, holds that field's name only in its path, so each op is read as the object it
// writes.
function sheetsAsStored(doc: Y.Doc): unknown[] {
    const snapshot = readSheetsSnapshotJson(doc);
    const ops = sheetsOpLog(doc)
        .toArray()
        .flatMap((batch) => {
            if (!Array.isArray(batch)) throw new Error('Unreadable sheets op batch');
            return batch.map(writtenObject);
        });
    return [snapshot ? decodeSheetsSnapshot(snapshot) : [], ops];
}

function writtenObject(op: Op): unknown {
    if (!isRecord(op) || !Array.isArray(op.path)) throw new Error('Unreadable sheets op');
    return op.path.reduceRight<unknown>((value, key) => ({ [key]: value }), op.value);
}

// Every card id under a cell's anchor field, however deep: a cell holds a list, an op that adds one id holds the id.
function cellCardIds(tree: unknown): Set<string> {
    const ids = new Set<string>();
    const stack: [unknown, boolean][] = [[tree, false]];
    for (let item = stack.pop(); item; item = stack.pop()) {
        const [value, anchored] = item;
        if (anchored && typeof value === 'string' && value) ids.add(value);
        if (!value || typeof value !== 'object') continue;
        for (const [key, child] of Object.entries(value)) stack.push([child, anchored || key === CELL_ANCHOR]);
    }
    return ids;
}
