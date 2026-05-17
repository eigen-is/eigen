import { useEffect, useState } from 'react';
import type * as Y from 'yjs';
import type { CommentCard } from '../../../types/comments';

function readCards(map: Y.Map<Y.Map<unknown>>): Record<string, CommentCard> {
    const out: Record<string, CommentCard> = {};
    map.forEach((yCard, id) => {
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
    });
    return out;
}

export function useCommentCards(
    doc: Y.Doc | null,
    mapName: 'comments' | 'tasks' = 'comments',
): Record<string, CommentCard> {
    const [cards, setCards] = useState<Record<string, CommentCard>>({});

    useEffect(() => {
        if (!doc) {
            setCards({});
            return;
        }
        const map = doc.getMap<Y.Map<unknown>>(mapName);
        const refresh = () => setCards(readCards(map));
        refresh();
        map.observeDeep(refresh);
        return () => map.unobserveDeep(refresh);
    }, [doc, mapName]);

    return cards;
}

export { readCards };
