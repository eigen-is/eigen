// Builds the stickies board Y.Doc structure for the committed fixture container. Kept separate from
// the authoring script so the exact Yjs shapes (which the shipped editors and readers depend on) live
// in one place. The frontend readers require `taskIds`/`columnOrder` to be real Y.Array instances.
// (The slides deck and budget sheet fixtures are hand-maintained — edited in a live demo and copied
// back — so they have no builder here.)
import { getIdArrayRoot, getItemMapRoot } from '@workspace/lib/collab/yjs-utils';
import * as Y from 'yjs';
import type { CardSpec } from './content';

// Cards embed `creator` as a bare persona key here; the seeder domainises it to an email after
// placing the fixture, so the board resolves author names regardless of the deployment's mail
// domain. `boardAuthor` is the persona key that owns the columns.
export function buildStickiesDoc(doc: Y.Doc, columns: string[], cards: CardSpec[], boardAuthor: string): void {
    const columnsMap = getItemMapRoot(doc, 'columns');
    const tasksMap = getItemMapRoot(doc, 'tasks');
    const columnOrder = getIdArrayRoot(doc, 'columnOrder');
    doc.transact(() => {
        const now = Date.now();
        // Hold each column's taskIds array by title — the card loop pushes into it, no re-lookup.
        const taskIdsByTitle = new Map<string, Y.Array<string>>();
        for (const [i, title] of columns.entries()) {
            const colId = `col-${i + 1}`;
            const taskIds = new Y.Array<string>();
            taskIdsByTitle.set(title, taskIds);
            const col = new Y.Map<unknown>();
            col.set('id', colId);
            col.set('title', title);
            col.set('taskIds', taskIds);
            col.set('creator', boardAuthor);
            col.set('createdAt', now);
            columnsMap.set(colId, col);
            columnOrder.push([colId]);
        }
        for (const [i, card] of cards.entries()) {
            const cardId = `card-${i + 1}`;
            const taskIds = taskIdsByTitle.get(card.column);
            if (!taskIds) throw new Error(`Card "${card.title}" references unknown column "${card.column}"`);
            const task = new Y.Map<unknown>();
            task.set('id', cardId);
            task.set('title', card.title);
            task.set('description', card.description);
            task.set('creator', card.creator);
            task.set('createdAt', now);
            tasksMap.set(cardId, task);
            taskIds.push([cardId]);
        }
    });
}
