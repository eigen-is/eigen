import type { Cell } from '@workspace/fortune-sheet';
import { useMemo } from 'react';

type ActiveComments = {
    ids: Set<string>;
    anchorTexts: Map<string, string>;
};

const EMPTY: ActiveComments = { ids: new Set(), anchorTexts: new Map() };

function columnToLetter(c: number): string {
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
                if (!cell?.commentChatNames?.length) continue;
                for (const chatName of cell.commentChatNames) {
                    ids.add(chatName);
                    if (!anchorTexts.has(chatName)) {
                        anchorTexts.set(chatName, `Cell ${columnToLetter(c)}${r + 1}`);
                    }
                }
            }
        }

        if (ids.size === 0) return EMPTY;
        return { ids, anchorTexts };
    }, [flowdata]);
}
