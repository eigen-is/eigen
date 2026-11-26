// A document's comment cards as React reads them: readCards turns the Y.Map that holds them into plain
// CommentCard objects, sanitizing each description on the way, and useCommentCards keeps that read live.
// Every host reads its cards through here, such as the comment lifecycle bundle and a canvas's active set.
// isCommentCard is the one test of what counts as a card, so a list of card ids, such as a board's, names
// only cards this read holds.

import { useEffect, useState } from 'react';
import * as Y from 'yjs';
import type { ChatAttachment } from '../../../types/chat';
import type { CommentCard, CommentMapName } from '../../../types/comments';
import { getItemMapRoot } from '../../collab/yjs-utils';
import { sanitizeCommentCardHtml } from '../../html-dom';

export function useCommentCards(doc: Y.Doc | null, mapName: CommentMapName = 'comments'): Record<string, CommentCard> {
    // The first render reads the cards at once. A host that mounts after the Yjs sync, such as docs, must see its
    // cards right away, or for one render a ?chat= landing finds no card and reads as deleted or closes.
    const [cards, setCards] = useState<Record<string, CommentCard>>(() =>
        doc ? readCards(getItemMapRoot(doc, mapName)) : {},
    );

    useEffect(() => {
        if (!doc) {
            setCards({});
            return;
        }
        const map = getItemMapRoot(doc, mapName);
        // A card whose fields are unchanged keeps its previous object, so a memoized card component skips the
        // render when an edit elsewhere rebuilds the map.
        const refresh = () =>
            setCards((prev) => {
                const next = readCards(map);
                for (const id in next) {
                    if (prev[id] && sameCard(prev[id], next[id])) next[id] = prev[id];
                }
                return next;
            });
        refresh();
        map.observeDeep(refresh);
        return () => map.unobserveDeep(refresh);
    }, [doc, mapName]);

    return cards;
}

// A card's map with its thread's name. Its own get comes first, so it wins the overload.
type YCommentCard = { get(key: 'chatName'): string } & Y.Map<unknown>;

// A card is a comment card, so an entry without a thread is no card.
export function isCommentCard(value: unknown): value is YCommentCard {
    return value instanceof Y.Map && typeof value.get('chatName') === 'string';
}

function readCards(map: Y.Map<unknown>): Record<string, CommentCard> {
    const out: Record<string, CommentCard> = {};
    for (const [id, yCard] of map) {
        if (!isCommentCard(yCard)) continue;
        const chatName = yCard.get('chatName');
        const title = yCard.get('title');
        const description = yCard.get('description');
        const color = yCard.get('color');
        const creator = yCard.get('creator');
        const createdAt = yCard.get('createdAt');
        const attachments = yCard.get('attachments');
        const deletedAt = yCard.get('deletedAt');
        out[id] = {
            id,
            title: typeof title === 'string' ? title : '',
            // Every reader of a card's description goes through here, so this is where a hostile peer's write is
            // sanitized, before anything renders it as HTML.
            description: typeof description === 'string' ? sanitizeCommentCardHtml(description) : '',
            color: typeof color === 'string' ? color : undefined,
            chatName,
            creator: typeof creator === 'string' ? creator : undefined,
            createdAt: typeof createdAt === 'number' ? createdAt : undefined,
            // A peer can write anything into the list, and sameAttachments and the chips read each entry as a file name
            // or a reference, so anything else would crash the render.
            attachments: Array.isArray(attachments)
                ? attachments.filter(
                      (a): a is ChatAttachment =>
                          typeof a === 'string' ||
                          (a?.type === 'reference' && typeof a.name === 'string' && typeof a.mimeType === 'string'),
                  )
                : undefined,
            deletedAt: typeof deletedAt === 'number' ? deletedAt : undefined,
        };
    }
    return out;
}

function sameCard(a: CommentCard, b: CommentCard): boolean {
    return (
        a.title === b.title &&
        a.description === b.description &&
        a.color === b.color &&
        a.chatName === b.chatName &&
        a.creator === b.creator &&
        a.createdAt === b.createdAt &&
        a.deletedAt === b.deletedAt &&
        sameAttachments(a.attachments, b.attachments)
    );
}

function sameAttachments(a?: readonly ChatAttachment[], b?: readonly ChatAttachment[]): boolean {
    if (a === b) return true;
    if (!a || !b || a.length !== b.length) return false;
    return a.every((x, i) => {
        const y = b[i];
        if (typeof x === 'string' || typeof y === 'string') return x === y;
        return x.id === y.id && x.name === y.name;
    });
}
