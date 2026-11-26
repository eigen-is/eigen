// A board whose doc syncs empty gets the default columns and a welcome card with its own thread, and a card stored
// without a thread gets one, but only for someone who may write it. A reader of a shared board would try to create the
// thread in the sharer's drive and write a board only their own screen shows.
import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';
import * as Y from 'yjs';

installHappyDom();

const createChat = mock(async (_input: { parentId: string; fileName: string }) => ({ name: 'task-chat' }));
const { isCommentCard } = await import('@workspace/lib/comments');
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

async function openBoard(canWrite: boolean) {
    function Board() {
        useBoard('owner-1', 'default', 'board-1', 'chats-1', canWrite);
        return null;
    }
    ({ unmount } = await renderInDocument(createElement(Board)));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

async function openEmptyBoard(canWrite: boolean) {
    doc = new Y.Doc();
    await openBoard(canWrite);
}

// A board whose one card was stored without a thread, under the undo manager the real doc builds.
function boardWithThreadlessCard(): { card: Y.Map<unknown>; undoManager: Y.UndoManager } {
    doc = new Y.Doc();
    const card = new Y.Map<unknown>();
    card.set('title', 'Old card');
    doc.getMap('tasks').set('card-1', card);
    const column = new Y.Map<unknown>();
    column.set('taskIds', Y.Array.from(['card-1']));
    doc.getMap('columns').set('col', column);
    doc.getArray('columnOrder').push(['col']);
    return {
        card,
        undoManager: new Y.UndoManager([doc.getMap('columns'), doc.getMap('tasks'), doc.getArray('columnOrder')]),
    };
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

test('a writer opening a board gives a card stored without a thread its own, which undo keeps', async () => {
    const { card, undoManager } = boardWithThreadlessCard();
    await openBoard(true);
    expect(createChat).toHaveBeenCalledTimes(1);
    expect(createChat.mock.calls[0][0].parentId).toBe('chats-1');
    expect(card.get('chatName')).toBe('task-chat');
    expect(isCommentCard(card)).toBe(true);
    undoManager.undo();
    expect(card.get('chatName')).toBe('task-chat');
});

test('a reader opening a board with a card stored without a thread writes nothing', async () => {
    const { card } = boardWithThreadlessCard();
    let updates = 0;
    doc.on('update', () => updates++);
    await openBoard(false);
    expect(createChat).not.toHaveBeenCalled();
    expect(updates).toBe(0);
    expect(card.has('chatName')).toBe(false);
});

test('a thread that fails to create leaves its card as it is', async () => {
    const { card } = boardWithThreadlessCard();
    createChat.mockImplementationOnce(async () => {
        throw new Error('quota');
    });
    await openBoard(true);
    expect(createChat).toHaveBeenCalledTimes(1);
    expect(card.has('chatName')).toBe(false);
});

test("a card a peer gives a thread while ours is created keeps the peer's", async () => {
    const { card } = boardWithThreadlessCard();
    createChat.mockImplementationOnce(async () => {
        card.set('chatName', 'peer-chat');
        return { name: 'task-chat' };
    });
    await openBoard(true);
    expect(card.get('chatName')).toBe('peer-chat');
});
