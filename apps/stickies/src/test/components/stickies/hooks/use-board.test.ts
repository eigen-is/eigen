import { describe, expect, it } from 'bun:test';
import { getItemMapRoot } from '@workspace/lib/collab';
import * as Y from 'yjs';
import { readColumns } from '../../../../components/stickies/hooks/use-board';

describe('readColumns', () => {
    it("reads a column's fields by type and skips a peer's scalar entry", () => {
        const doc = new Y.Doc();
        const columns = doc.getMap<unknown>('columns');
        doc.transact(() => {
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

        expect(readColumns(getItemMapRoot(doc, 'columns'))).toEqual({
            c1: { id: 'c1', title: 'To Do', taskIds: ['t1'], creator: 'alice@example.com', createdAt: 1700000000000 },
            c2: { id: 'c2', title: '', taskIds: [], creator: '', createdAt: 0 },
        });
    });
});
