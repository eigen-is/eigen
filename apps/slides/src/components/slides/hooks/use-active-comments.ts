import { htmlToPlainText } from '@workspace/lib/html-dom';
import type { ActiveComments } from '@workspace/lib/types/comments';
import { useMemo } from 'react';
import type { DeckData } from '../types';

const EMPTY: ActiveComments = { ids: new Set(), anchorTexts: new Map() };

export function useActiveComments(deck: DeckData): ActiveComments {
    return useMemo(() => {
        const ids = new Set<string>();
        const anchorTexts = new Map<string, string>();

        for (const obj of Object.values(deck.objects)) {
            for (const cardId of obj.commentCardIds ?? []) {
                ids.add(cardId);
                if (!anchorTexts.has(cardId)) {
                    anchorTexts.set(cardId, obj.type === 'text' ? htmlToPlainText(obj.text).slice(0, 100) : 'Image');
                }
            }
        }

        if (ids.size === 0) return EMPTY;
        return { ids, anchorTexts };
    }, [deck.objects]);
}
