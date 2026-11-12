// A board whose doc syncs empty gets the default columns and a welcome card with its own thread, but only for someone
// who may write it. A reader of a shared board that was never opened would try to create the thread in the sharer's
// drive and seed a board only their own screen shows.
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

async function openEmptyBoard(canWrite: boolean) {
    doc = new Y.Doc();
    function Board() {
        useBoard('owner-1', 'default', 'board-1', 'chats-1', canWrite);
        return null;
    }
    ({ unmount } = await renderInDocument(createElement(Board)));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

test('a writer opening an empty board seeds the default columns and the welcome card with its thread', async () => {
    await openEmptyBoard(true);
    expect(createChat).toHaveBeenCalledTimes(1);
    expect(createChat.mock.calls[0][0].parentId).toBe('chats-1');
    const board = readBoard(doc);
    expect(board.columnOrder.map((id) => board.columns[id].title)).toEqual(['To Do', 'In Progress', 'Done']);
    expect(doc.getMap('tasks').size).toBe(1);
});

test('a reader opening an empty board creates no thread and seeds nothing', async () => {
    await openEmptyBoard(false);
    expect(createChat).not.toHaveBeenCalled();
    expect(doc.getMap('columns').size).toBe(0);
    expect(doc.getMap('tasks').size).toBe(0);
});
