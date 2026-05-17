import type { ActiveComments } from '@workspace/lib/types/comments';
import type { Cell } from '@workspace/sheet';
import { useMemo } from 'react';

const EMPTY: ActiveComments = { ids: new Set(), anchorTexts: new Map() };

export function columnToLetter(c: number): string {
    let result = '';
    let n = c;
    while (n >= 0) {
        result = String.fromCharCode((n % 26) + 65) + result;
        n = Math.floor(n / 26) - 1;
    }
    return result;
}

export function useActiveComments(flowdata: (Cell | null)[][] | undefined): ActiveComments {
    return useMemo(() => {
        if (!flowdata) return EMPTY;

        const ids = new Set<string>();
        const anchorTexts = new Map<string, string>();

        for (let r = 0; r < flowdata.length; r++) {
            const row = flowdata[r];
            if (!row) continue;
            for (let c = 0; c < row.length; c++) {
                const cell = row[c];
                if (!cell?.commentCardIds?.length) continue;
                for (const cardId of cell.commentCardIds) {
                    ids.add(cardId);
                    if (!anchorTexts.has(cardId)) {
                        anchorTexts.set(cardId, `Cell ${columnToLetter(c)}${r + 1}`);
                    }
                }
            }
        }

        if (ids.size === 0) return EMPTY;
        return { ids, anchorTexts };
    }, [flowdata]);
}
