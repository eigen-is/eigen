// A board whose doc syncs empty gets the default columns and a welcome card with its own thread, but only for someone
// who may write it. A reader of a shared board that was never opened would try to create the thread in the sharer's
// drive and seed a board only their own screen shows. A card that loses its thread leaves the board at once.
import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';
import * as Y from 'yjs';

installHappyDom();

const createChat = mock(async (_input: { parentId: string; fileName: string }) => ({ name: 'task-chat' }));
let doc = new Y.Doc();

const { act, createElement, useEffect, useRef } = await import('react');
const realCollab = { ...(await import('@workspace/lib/collab')) };
const realDrive = { ...(await import('@workspace/lib/drive')) };
const realAuth = { ...(await import('@workspace/lib/auth')) };
mock.module('@workspace/lib/collab', () => ({
    ...realCollab,
    // The doc has synced and is empty, as a board nobody has opened yet.
    useCollabDoc: ({
        onInit,
        onSync,
    }: {
        onInit: (state: { doc: Y.Doc }) => () => void;
        onSync: (state: { doc: Y.Doc }, synced: boolean) => void;
    }) => {
        // The hook's onInit is a new function each render, and the real doc runs it once.
        const init = useRef(onInit);
        useEffect(() => init.current({ doc }), []);
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

// The ids the hook's board lists, as last rendered.
let shownIds: string[] = [];

async function openEmptyBoard(canWrite: boolean) {
    doc = new Y.Doc();
    function Board() {
        const { board } = useBoard('owner-1', 'default', 'board-1', 'chats-1', canWrite);
        shownIds = Object.values(board.columns).flatMap((column) => column.taskIds);
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

test("a card a peer strips of its thread leaves the board's columns", async () => {
    await openEmptyBoard(true);
    expect(shownIds.length).toBe(1);
    const welcome = doc.getMap('tasks').get(shownIds[0]);
    if (!(welcome instanceof Y.Map)) throw new Error('no welcome card');
    await act(async () => welcome.delete('chatName'));
    expect(shownIds).toEqual([]);
});
