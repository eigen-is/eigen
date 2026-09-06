import { useEffect, useState } from 'react';
import type * as Y from 'yjs';
import type { ChatAttachment } from '../../../types/chat';
import type { CommentCard } from '../../../types/comments';
import { getItemMapRoot } from '../../collab/yjs-utils';
import { sanitizeCommentCardHtml } from '../../html-dom';

function readCards(map: Y.Map<Y.Map<unknown>>): Record<string, CommentCard> {
    const out: Record<string, CommentCard> = {};
    for (const [id, yCard] of map) {
        const title = yCard.get('title');
        const description = yCard.get('description');
        const color = yCard.get('color');
        const chatName = yCard.get('chatName');
        const creator = yCard.get('creator');
        const createdAt = yCard.get('createdAt');
        const attachments = yCard.get('attachments');
        out[id] = {
            id,
            title: typeof title === 'string' ? title : '',
            // The one read seam every consumer of a card's description passes through, so it is where
            // a hostile peer's Y.Doc write is sanitized before any dangerouslySetInnerHTML render.
            description: typeof description === 'string' ? sanitizeCommentCardHtml(description) : '',
            color: typeof color === 'string' ? color : undefined,
            chatName: typeof chatName === 'string' ? chatName : undefined,
            creator: typeof creator === 'string' ? creator : undefined,
            createdAt: typeof createdAt === 'number' ? createdAt : undefined,
            // Element filter guards against malformed values from buggy peers — a null/number
            // element would crash sameAttachments and the chip renderers.
            attachments: Array.isArray(attachments)
                ? attachments.filter(
                      (a): a is ChatAttachment => typeof a === 'string' || (typeof a === 'object' && a !== null),
                  )
                : undefined,
        };
    }
    return out;
}

function sameAttachments(a?: ChatAttachment[], b?: ChatAttachment[]): boolean {
    if (a === b) return true;
    if (!a || !b || a.length !== b.length) return false;
    return a.every((x, i) => {
        const y = b[i];
        if (typeof x === 'string' || typeof y === 'string') return x === y;
        return x.id === y.id && x.name === y.name;
    });
}

function sameCard(a: CommentCard, b: CommentCard): boolean {
    return (
        a.title === b.title &&
        a.description === b.description &&
        a.color === b.color &&
        a.chatName === b.chatName &&
        a.creator === b.creator &&
        a.createdAt === b.createdAt &&
        sameAttachments(a.attachments, b.attachments)
    );
}

export function useCommentCards(
    doc: Y.Doc | null,
    mapName: 'comments' | 'tasks' = 'comments',
): Record<string, CommentCard> {
    // Read synchronously on first render — a host that mounts after Yjs sync (docs) must see its
    // cards immediately, or the ?chat= deep-link effect runs once against {} and gives up.
    const [cards, setCards] = useState<Record<string, CommentCard>>(() =>
        doc ? readCards(getItemMapRoot(doc, mapName)) : {},
    );

    useEffect(() => {
        if (!doc) {
            setCards({});
            return;
        }
        const map = getItemMapRoot(doc, mapName);
        // Reuse the previous card object when its fields are unchanged, so memoized
        // card components skip re-rendering when an edit elsewhere rebuilds the map.
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

export { readCards };
