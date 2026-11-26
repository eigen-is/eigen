// A board whose doc syncs empty gets the default columns and a welcome card with its own thread, but only for someone
// who may write it. A reader of a shared board that was never opened would try to create the thread in the sharer's
// drive and seed a board only their own screen shows. The same holds for the repair of a card no column lists.
import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';
import * as Y from 'yjs';

installHappyDom();

const createChat = mock(async (_input: { parentId: string; fileName: string }) => ({ name: 'task-chat' }));
let doc = new Y.Doc();

const { act, createElement, useEffect } = await import('react');
const realCollab = { ...(await import('@workspace/lib/collab')) };
const realDrive = { ...(await import('@workspace/lib/drive')) };
const realAuth = { ...(await import('@workspace/lib/auth')) };
mock.module('@workspace/lib/collab', () => ({
    ...realCollab,
    // The doc has synced and is empty, as a board nobody has opened yet.
    useCollabDoc: ({ onSync }: { onSync: (state: { doc: Y.Doc }, synced: boolean) => void }) => {
        useEffect(() => onSync({ doc }, true), [onSync]);
        return { docRef: { current: doc }, doc, synced: true, loaded: true };
    },
}));
mock.module('@workspace/lib/drive', () => ({ ...realDrive, useCreateDriveItem: () => ({ mutateAsync: createChat }) }));
mock.module('@workspace/lib/auth', () => ({ ...realAuth, useAuth: () => ({ user: { email: 'ann@example.com' } }) }));
afterAll(() => {
    mock.module('@workspace/lib/collab', () => realCollab);
    mock.module('@workspace/lib/drive', () => realDrive);
    mock.module('@workspace/lib/auth', () => realAuth);
});

const { readBoard, useBoard } = await import('../../../../components/stickies/hooks/use-board');

let unmount = async () => {};
afterEach(async () => {
    await unmount();
    createChat.mockClear();
});

// Opens the board `stored` writes, empty by default, and returns how many updates its doc took on open.
async function openBoard(canWrite: boolean, stored: (doc: Y.Doc) => void = () => {}): Promise<number> {
    doc = new Y.Doc();
    stored(doc);
    let updates = 0;
    doc.on('update', () => updates++);
    function Board() {
        useBoard('owner-1', 'default', 'board-1', 'chats-1', canWrite);
        return null;
    }
    ({ unmount } = await renderInDocument(createElement(Board)));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    return updates;
}

// One column, and a card no column lists, which the repair puts in the first column.
function strayCard(stored: Y.Doc) {
    const column = new Y.Map<unknown>();
    column.set('title', 'To Do');
    column.set('taskIds', new Y.Array<string>());
    stored.getMap('columns').set('c1', column);
    stored.getArray<string>('columnOrder').push(['c1']);
    stored.getMap('tasks').set('t1', new Y.Map());
}

test('a writer opening an empty board seeds the default columns and the welcome card with its thread', async () => {
    await openBoard(true);
    expect(createChat).toHaveBeenCalledTimes(1);
    expect(createChat.mock.calls[0][0].parentId).toBe('chats-1');
    const board = readBoard(doc);
    expect(board.columnOrder.map((id) => board.columns[id].title)).toEqual(['To Do', 'In Progress', 'Done']);
    expect(doc.getMap('tasks').size).toBe(1);
});

test('a reader opening an empty board creates no thread and seeds nothing', async () => {
    await openBoard(false);
    expect(createChat).not.toHaveBeenCalled();
    expect(doc.getMap('columns').size).toBe(0);
    expect(doc.getMap('tasks').size).toBe(0);
});

test('a writer opening a board with a stray card files it in the first column', async () => {
    await openBoard(true, strayCard);
    expect(readBoard(doc).columns.c1.taskIds).toEqual(['t1']);
});

test("a reader's board with a stray card stays as stored, since the server drops a reader's repair", async () => {
    expect(await openBoard(false, strayCard)).toBe(0);
    expect(readBoard(doc).columns.c1.taskIds).toEqual([]);
});
