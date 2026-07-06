import { stripTagsServer } from '@workspace/lib/html';
import type { CommentCard } from '@workspace/lib/types/comments';
import type { DocSearchMatch } from '@workspace/lib/types/doc-search';
import type { BoardData } from './types';

// Pure board text scan: column titles + each card's title/description (HTML stripped), in
// board reading order. Ids are prefixed so reveal can route columns vs cards.
export function searchBoard(board: BoardData, cards: Record<string, CommentCard>, regex: RegExp): DocSearchMatch[] {
    const matches: DocSearchMatch[] = [];
    for (const columnId of board.columnOrder) {
        const column = board.columns[columnId];
        if (!column) continue;
        if ((column.title.match(regex) ?? []).length > 0) {
            matches.push({ id: `column:${columnId}`, label: column.title, context: 'Column' });
        }
        for (const taskId of column.taskIds) {
            const card = cards[taskId];
            if (!card) continue;
            const haystack = `${card.title}\n${stripTagsServer(card.description)}`;
            if ((haystack.match(regex) ?? []).length > 0) {
                matches.push({ id: `card:${card.id}`, label: card.title || 'Untitled', context: column.title });
            }
        }
    }
    return matches;
}
