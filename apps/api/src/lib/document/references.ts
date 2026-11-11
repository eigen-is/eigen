// What a collab document's state names among its own parts: the files in its media folder and the threads in its
// chat folder. The sweep deletes the parts its current state does not name, so a missed name deletes a part in use,
// and each reader errs on the side of more names. The canvas and the board drop what their editors drop. A workbook
// it can't decode and a card in a shape no editor writes throw, which the sweep takes as "delete nothing". The
// references job runs this in the transform process.

import { yXmlFragmentToProsemirrorJSON } from '@tiptap/y-tiptap';
import { boardCardIds, getItemMapRoot } from '@workspace/lib/collab/yjs-utils';
import { commentCardIdsIn } from '@workspace/lib/docs/eigendoc';
import type { Cell } from '@workspace/lib/sheets';
import { decodeSheetsSnapshot, readSheetsLog, readSheetsSnapshotJson } from '@workspace/lib/sheets';
import type { ChatAttachment } from '@workspace/lib/types/chat';
import type { CommentCard, CommentMapName } from '@workspace/lib/types/comments';
import { commentMapName } from '@workspace/lib/types/comments';
import type { DriveCollabType } from '@workspace/lib/types/drive';
import { EIGEN_DOC_TYPE_INFO } from '@workspace/lib/types/drive';
import { isAttachmentReferenceShape } from '@workspace/lib/types/drive-reference';
import { activeCommentCardIds, readVectorFromDoc } from '@workspace/lib/vector';
import * as Y from 'yjs';
import { mediaNamesIn, sceneMediaNames } from './media';

// The names a state gives, each list sorted.
export type DocumentReferences = { media: string[]; chat: string[] };

// The doc's body and its bands, and any other fragment the doc declares.
const DOC_FRAGMENTS = Object.entries(EIGEN_DOC_TYPE_INFO.doc.yjsRoots)
    .filter(([, kind]) => kind === 'xmlfragment')
    .map(([root]) => root);

// The field a cell keeps its comment cards in.
const CELL_ANCHOR = 'commentCardIds' satisfies keyof Cell;

// Only a card in use names its thread and its files, such as a card the content anchors. An attachment that is a Drive
// reference names a document elsewhere, not a file in media/.
export function documentReferences(type: DriveCollabType, doc: Y.Doc): DocumentReferences {
    const cards = readCards(doc, commentMapName(type));
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
            // The sheets the snapshot stores and every op still pending, read without a replay. An op that writes one field holds
            // that field's name only in its path, so each op is read as the object it writes.
            const snapshot = readSheetsSnapshotJson(doc);
            const ops = readSheetsLog(doc)
                .flat()
                .map((op) => op.path.reduceRight<unknown>((value, key) => ({ [key]: value }), op.value));
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

// Stricter than the client's lenient reader about the fields that name a part: a shape no editor writes throws, rather
// than silently drop a part it may name.
function readCards(doc: Y.Doc, mapName: CommentMapName): Record<string, CommentCard> {
    const entries = [...getItemMapRoot(doc, mapName)].map(([id, card]): [string, CommentCard] => {
        if (!(card instanceof Y.Map)) throw new Error(`Unreadable comment card ${id}`);
        const title: unknown = card.get('title');
        const description: unknown = card.get('description');
        const chatName: unknown = card.get('chatName');
        const attachments: unknown = card.get('attachments') ?? [];
        const deletedAt: unknown = card.get('deletedAt');
        if (
            (chatName !== undefined && typeof chatName !== 'string') ||
            !Array.isArray(attachments) ||
            // An attachment is a file name in media/, or a Drive reference as toAttachmentReference writes it.
            !attachments.every(
                (item): item is ChatAttachment => typeof item === 'string' || isAttachmentReferenceShape(item),
            )
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
                deletedAt: typeof deletedAt === 'number' ? deletedAt : undefined,
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
