import { htmlToPlainText } from '@workspace/lib/html';
import { useMemo } from 'react';
import type { DeckData } from '../types';

type ActiveComments = {
    ids: Set<string>;
    anchorTexts: Map<string, string>;
};

const EMPTY: ActiveComments = { ids: new Set(), anchorTexts: new Map() };

export function useActiveComments(deck: DeckData): ActiveComments {
    return useMemo(() => {
        const ids = new Set<string>();
        const anchorTexts = new Map<string, string>();

        for (const obj of Object.values(deck.objects)) {
            if (!obj.commentChatNames?.length) continue;
            for (const chatName of obj.commentChatNames) {
                ids.add(chatName);
                if (!anchorTexts.has(chatName)) {
                    anchorTexts.set(chatName, obj.type === 'text' ? htmlToPlainText(obj.text).slice(0, 100) : 'Image');
                }
            }
        }

        if (ids.size === 0) return EMPTY;
        return { ids, anchorTexts };
    }, [deck.objects]);
}
