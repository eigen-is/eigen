import { describe, expect, it } from 'bun:test';
import * as Y from 'yjs';
import { readBoard } from '../../../../components/stickies/hooks/use-board';

describe('readBoard', () => {
    it("reads a column's fields by type and skips a peer's scalar entry", () => {
        const doc = new Y.Doc();
        const columns = doc.getMap<unknown>('columns');
        doc.transact(() => {
            doc.getMap<unknown>('tasks').set('t1', new Y.Map());

            const good = new Y.Map<unknown>();
            good.set('title', 'To Do');
            good.set('taskIds', Y.Array.from(['t1']));
            good.set('creator', 'alice@example.com');
            good.set('createdAt', 1700000000000);
            columns.set('c1', good);

            const malformed = new Y.Map<unknown>();
            malformed.set('title', 42);
            malformed.set('creator', { name: 'bob' });
            malformed.set('createdAt', 'yesterday');
            columns.set('c2', malformed);

            columns.set('c3', 'not-a-column');
        });

        expect(readBoard(doc).columns).toEqual({
            c1: { id: 'c1', title: 'To Do', taskIds: ['t1'], creator: 'alice@example.com', createdAt: 1700000000000 },
            c2: { id: 'c2', title: '', taskIds: [], creator: '', createdAt: 0 },
        });
    });

    // The board looks up every listed column and card, so an id it could not read must not be listed.
    it('lists only the columns and cards it could read', () => {
        const doc = new Y.Doc();
        doc.transact(() => {
            const tasks = doc.getMap<unknown>('tasks');
            tasks.set('t1', new Y.Map());
            tasks.set('t2', 'not-a-card');

            const column = new Y.Map<unknown>();
            column.set('taskIds', Y.Array.from(['t1', 't2', 'gone']));
            const columns = doc.getMap<unknown>('columns');
            columns.set('c1', column);
            columns.set('c2', 'not-a-column');
            doc.getArray<string>('columnOrder').push(['c1', 'c2', 'gone', 'constructor']);
        });

        const board = readBoard(doc);
        expect(board.columnOrder).toEqual(['c1']);
        expect(board.columns.c1.taskIds).toEqual(['t1']);
    });
});
