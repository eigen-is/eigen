import { useEffect, useState } from 'react';
import type * as Y from 'yjs';
import type { CommentCard } from '../../../types/comments';

function readCards(map: Y.Map<Y.Map<unknown>>): Record<string, CommentCard> {
    const out: Record<string, CommentCard> = {};
    for (const [id, yCard] of map) {
        const title = yCard.get('title');
        const description = yCard.get('description');
        const color = yCard.get('color');
        const chatName = yCard.get('chatName');
        const creator = yCard.get('creator');
        const createdAt = yCard.get('createdAt');
        out[id] = {
            id,
            title: typeof title === 'string' ? title : '',
            description: typeof description === 'string' ? description : '',
            color: typeof color === 'string' ? color : undefined,
            chatName: typeof chatName === 'string' ? chatName : undefined,
            creator: typeof creator === 'string' ? creator : undefined,
            createdAt: typeof createdAt === 'number' ? createdAt : undefined,
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
        a.createdAt === b.createdAt
    );
}

export function useCommentCards(
    doc: Y.Doc | null,
    mapName: 'comments' | 'tasks' = 'comments',
): Record<string, CommentCard> {
    // Read synchronously on first render — a host that mounts after Yjs sync (docs) must see its
    // cards immediately, or the ?chat= deep-link effect runs once against {} and gives up.
    const [cards, setCards] = useState<Record<string, CommentCard>>(() =>
        doc ? readCards(doc.getMap<Y.Map<unknown>>(mapName)) : {},
    );

    useEffect(() => {
        if (!doc) {
            setCards({});
            return;
        }
        const map = doc.getMap<Y.Map<unknown>>(mapName);
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
