import { describe, expect, it } from 'bun:test';
import { buildSearchRegex } from '@workspace/lib/doc-search';
import type { CommentCard } from '@workspace/lib/types/comments';
import { searchBoard } from '../../../components/stickies/search-board';
import type { BoardData } from '../../../components/stickies/types';

const OPTS = { matchCase: false, wholeWord: false, regex: false };
function re(q: string): RegExp {
    const regex = buildSearchRegex(q, OPTS);
    if (!regex) throw new Error(`buildSearchRegex(${q}) returned null`);
    return regex;
}

const board: BoardData = {
    columnOrder: ['c1', 'c2'],
    columns: {
        c1: { id: 'c1', title: 'To Do', taskIds: ['t1', 't2'], creator: '', createdAt: 0 },
        c2: { id: 'c2', title: 'Done', taskIds: [], creator: '', createdAt: 0 },
    },
};
const cards: Record<string, CommentCard> = {
    t1: { id: 't1', title: 'Buy milk', description: '<p>and <strong>eggs</strong></p>' },
    t2: { id: 't2', title: 'Walk dog', description: '' },
};

describe('searchBoard', () => {
    it('matches a card title and reports its column as context', () => {
        expect(searchBoard(board, cards, re('milk'))).toEqual([{ id: 'card:t1', label: 'Buy milk', context: 'To Do' }]);
    });

    it('matches inside the HTML description by its visible text', () => {
        expect(searchBoard(board, cards, re('eggs')).map((m) => m.id)).toEqual(['card:t1']);
    });

    it('matches a column title with a column: id', () => {
        expect(searchBoard(board, cards, re('done'))).toEqual([{ id: 'column:c2', label: 'Done', context: 'Column' }]);
    });

    it('returns matches in board order (column, then its cards)', () => {
        // 'o' hits "To Do", "Walk dog", "Done" — not "Buy milk"/"and eggs".
        expect(searchBoard(board, cards, re('o')).map((m) => m.id)).toEqual(['column:c1', 'card:t2', 'column:c2']);
    });

    it('returns [] when nothing matches', () => {
        expect(searchBoard(board, cards, re('zzz'))).toEqual([]);
    });
});
