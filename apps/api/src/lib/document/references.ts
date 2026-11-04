// What a state of a collab document names among its own parts, such as its current state or a saved version: the
// files in its `media/` folder and the comment threads in its `chat/` folder. A later sweep deletes the parts nothing
// names, so a name a reader misses deletes a part in use, and each reader errs on the side of more names. The canvas
// reads its content as its editor does and drops the shapes the editor drops. The other readers throw on a shape they
// do not know, which the sweep takes as "delete nothing". The references job runs it in the transform process.

import { yXmlFragmentToProsemirrorJSON } from '@tiptap/y-tiptap';
import { boardCardIds, getItemMapRoot } from '@workspace/lib/collab/yjs-utils';
import { commentCardIdsIn } from '@workspace/lib/docs/eigendoc';
import { isRecord } from '@workspace/lib/guards';
import type { Cell } from '@workspace/lib/sheets';
import { decodeSheetsSnapshot, readSheetsSnapshotJson, sheetsOpLog } from '@workspace/lib/sheets';
import type { ChatAttachment } from '@workspace/lib/types/chat';
import type { CommentCard } from '@workspace/lib/types/comments';
import type { DriveCollabType } from '@workspace/lib/types/drive';
import { EIGEN_DOC_TYPE_INFO } from '@workspace/lib/types/drive';
import { activeCommentCardIds, readVectorFromDoc } from '@workspace/lib/vector';
import * as Y from 'yjs';
import type { DocumentReferences } from '../mount/schema';
import { mediaNamesIn, sceneMediaNames } from './media';

// Bump it whenever what any reader here finds changes.
export const REFERENCE_READER_VERSION = 1;

// The doc's body and its bands, and any other fragment the doc declares.
const DOC_FRAGMENTS = Object.entries(EIGEN_DOC_TYPE_INFO.doc.yjsRoots)
    .filter(([, kind]) => kind === 'xmlfragment')
    .map(([root]) => root);

// The field a cell keeps its comment cards in.
const CELL_ANCHOR = 'commentCardIds' satisfies keyof Cell;

// Only a card in use names its thread and its files, such as a card the content anchors, or on a canvas a card nobody
// deleted. The rules a client shares live in lib beside it, such as the canvas's and the board's. An attachment that is
// a Drive reference names a document elsewhere, not a file in media/.
export function documentReferences(type: DriveCollabType, doc: Y.Doc): DocumentReferences {
    const cards = readCards(doc, type === 'stickies' ? 'tasks' : 'comments');
    let media: Set<string>;
    let inUse: Set<string>;
    switch (type) {
        case 'doc': {
            const fragments = DOC_FRAGMENTS.map((root) => yXmlFragmentToProsemirrorJSON(doc.getXmlFragment(root)));
            media = mediaNamesIn(fragments);
            inUse = commentCardIdsIn(fragments);
            break;
        }
        case 'slides':
        case 'vector': {
            const scene = readVectorFromDoc(doc);
            media = sceneMediaNames(scene);
            inUse = activeCommentCardIds(scene.elements, cards);
            break;
        }
        case 'sheets': {
            // The sheets the snapshot stores and every op still pending, read without a replay: an image or a comment
            // an op removed stays named until the next compaction. An op that writes one field, such as an upload's
            // final mediaName or one card id added to a cell's list, holds that field's name only in its path. So each
            // op is read as the object it writes.
            const snapshot = readSheetsSnapshotJson(doc);
            const ops = sheetsOpLog(doc)
                .toArray()
                .flatMap((batch) => {
                    if (!Array.isArray(batch)) throw new Error('Unreadable sheets op batch');
                    return batch.map((op) => {
                        if (!isRecord(op) || !Array.isArray(op.path)) throw new Error('Unreadable sheets op');
                        return op.path.reduceRight<unknown>((value, key) => ({ [key]: value }), op.value);
                    });
                });
            const sheets = [snapshot ? decodeSheetsSnapshot(snapshot) : [], ops];
            media = mediaNamesIn(sheets);
            inUse = cellCardIds(sheets);
            break;
        }
        case 'stickies':
            media = new Set();
            inUse = boardCardIds(doc);
            break;
    }
    const chat = new Set<string>();
    for (const card of Object.values(cards)) {
        if (!inUse.has(card.id)) continue;
        if (card.chatName) chat.add(card.chatName);
        for (const attachment of card.attachments ?? []) {
            if (typeof attachment === 'string') media.add(attachment);
        }
    }
    return { media: [...media].sort(), chat: [...chat].sort() };
}

// Two card readers exist on purpose. The client's readCards is lenient: it drops a field it cannot read and sanitizes
// the rest for display. This one is strict, so a field a peer wrote in a shape the editor never writes throws, rather
// than silently drop a thread or a file it may name. The title and the description name nothing, so they are read as
// leniently as readCards reads them.
function readCards(doc: Y.Doc, mapName: 'comments' | 'tasks'): Record<string, CommentCard> {
    const entries = [...getItemMapRoot(doc, mapName)].map(([id, card]): [string, CommentCard] => {
        if (!(card instanceof Y.Map)) throw new Error(`Unreadable comment card ${id}`);
        const title: unknown = card.get('title');
        const description: unknown = card.get('description');
        const chatName: unknown = card.get('chatName');
        const attachments: unknown = card.get('attachments') ?? [];
        const deletedAt: unknown = card.get('deletedAt');
        if (
            (chatName !== undefined && typeof chatName !== 'string') ||
            (deletedAt !== undefined && typeof deletedAt !== 'number') ||
            !Array.isArray(attachments) ||
            // A Drive reference is a record, and it names no file in media/.
            !attachments.every((item): item is ChatAttachment => typeof item === 'string' || isRecord(item))
        ) {
            throw new Error(`Unreadable comment card ${id}`);
        }
        return [
            id,
            {
                id,
                title: typeof title === 'string' ? title : '',
                description: typeof description === 'string' ? description : '',
                chatName,
                attachments,
                deletedAt,
            },
        ];
    });
    // fromEntries, so a card id such as `__proto__` stays a card of its own.
    return Object.fromEntries(entries);
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
