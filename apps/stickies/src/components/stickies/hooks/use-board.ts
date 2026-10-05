import { useAuth } from '@workspace/lib/auth';
import { getIdArray, getIdArrayRoot, getItemMapRoot, useCollabDoc } from '@workspace/lib/collab';
import { writeCardToDoc } from '@workspace/lib/comments';
import { EIGEN_STICKIES_COLORS } from '@workspace/lib/constants';
import { useCreateDriveItem } from '@workspace/lib/drive';
import { nanoid } from 'nanoid';
import { useCallback, useRef, useState } from 'react';
import * as Y from 'yjs';
import { normalizeBoard } from '../normalize-board';
import type { BoardData, ColumnItem } from '../types';

const DEFAULT_COLUMNS = ['To Do', 'In Progress', 'Done'];
const WELCOME_CARD = {
    title: 'Welcome to stickies!',
    description:
        'Drag this sticky to another column to get started. You can add more stickies with the "Add a sticky" button.',
};

// Reuse the previous column object when its fields are unchanged, so memoized
// columns skip re-rendering when an edit elsewhere on the board rebuilds state.
function sameColumn(a: ColumnItem, b: ColumnItem): boolean {
    return (
        a.title === b.title &&
        a.creator === b.creator &&
        a.createdAt === b.createdAt &&
        a.taskIds.length === b.taskIds.length &&
        a.taskIds.every((id, i) => id === b.taskIds[i])
    );
}

// Lists only the columns and cards it could read: the board looks up every listed id.
export function readBoard(doc: Y.Doc): BoardData {
    const tasksMap = getItemMapRoot(doc, 'tasks');
    const columns: Record<string, ColumnItem> = {};
    for (const [id, columnMap] of getItemMapRoot(doc, 'columns')) {
        if (!(columnMap instanceof Y.Map)) continue;
        const title = columnMap.get('title');
        const creator = columnMap.get('creator');
        const createdAt = columnMap.get('createdAt');
        columns[id] = {
            id,
            title: typeof title === 'string' ? title : '',
            taskIds: (getIdArray(columnMap, 'taskIds')?.toArray() ?? []).filter(
                (taskId) => tasksMap.get(taskId) instanceof Y.Map,
            ),
            creator: typeof creator === 'string' ? creator : '',
            // Stable fallback — a per-refresh Date.now() would defeat sameColumn for
            // legacy columns that predate the createdAt field. Nothing renders it.
            createdAt: typeof createdAt === 'number' ? createdAt : 0,
        };
    }
    const columnOrder = getIdArrayRoot(doc, 'columnOrder')
        .toArray()
        .filter((id) => Object.hasOwn(columns, id));
    return { columns, columnOrder };
}

export const useBoard = (ownerId: string, mountId: string, pathId: string, chatFolderId: string | null) => {
    const [board, setBoard] = useState<BoardData>({ columns: {}, columnOrder: [] });
    const [isAddColumnDialogOpen, setIsAddColumnDialogOpen] = useState(false);

    // Latched so normalize + seed run once per doc (reset in onInit on every pathId switch), not on
    // every 'sync' reconnect.
    const initializedRef = useRef(false);

    const { user } = useAuth();
    // Read the live email inside onSync (held in a ref by the shared hook) so an auth change never
    // tears down the live board — the doc is keyed strictly on ownerId/mountId/pathId.
    const userEmailRef = useRef(user?.email);
    userEmailRef.current = user?.email;
    const createChat = useCreateDriveItem('chat');
    const createChatRef = useRef(createChat);
    createChatRef.current = createChat;
    const chatFolderIdRef = useRef(chatFolderId);
    chatFolderIdRef.current = chatFolderId;

    const createCardChat = useCallback(async (): Promise<string | undefined> => {
        const folderId = chatFolderIdRef.current;
        if (!folderId) return undefined;
        const result = await createChatRef.current
            .mutateAsync({
                ownerId,
                mountId,
                parentId: folderId,
                fileName: `task-${nanoid(10)}`,
            })
            .catch(() => undefined);
        return result?.name;
    }, [ownerId, mountId]);

    const initializeDefaultBoard = useCallback(
        async (doc: Y.Doc, userEmail: string) => {
            const columnsMap = getItemMapRoot(doc, 'columns');
            if (columnsMap.size > 0) return;

            const chatName = await createCardChat();

            if (columnsMap.size > 0) return;
            const now = Date.now();

            doc.transact(() => {
                const columnOrderArray = getIdArrayRoot(doc, 'columnOrder');

                const taskId = `task-${nanoid(10)}`;
                writeCardToDoc(doc, 'tasks', {
                    id: taskId,
                    title: WELCOME_CARD.title,
                    description: WELCOME_CARD.description,
                    color: EIGEN_STICKIES_COLORS[0][1].value,
                    chatName,
                    creator: userEmail,
                    createdAt: now,
                });

                const columnIds: string[] = [];
                for (const [index, title] of DEFAULT_COLUMNS.entries()) {
                    const columnId = `column-${nanoid(10)}`;
                    columnIds.push(columnId);
                    const columnYMap = new Y.Map();
                    columnYMap.set('id', columnId);
                    columnYMap.set('title', title);
                    const taskIds = new Y.Array();
                    if (index === 0) taskIds.push([taskId]);
                    columnYMap.set('taskIds', taskIds);
                    columnYMap.set('creator', userEmail);
                    columnYMap.set('createdAt', now);
                    columnsMap.set(columnId, columnYMap);
                }

                columnOrderArray.insert(0, columnIds);
            });
        },
        [createCardChat],
    );

    const {
        docRef,
        provider,
        undoManager,
        doc: yjsDoc,
        synced: isSynced,
        offline,
        loaded,
        storageUnavailable,
        storageGone,
        unsyncedEdits,
    } = useCollabDoc({
        ownerId,
        mountId,
        pathId,
        undoScope: (doc) => [doc.getMap('columns'), doc.getMap('tasks'), doc.getArray('columnOrder')],
        onInit: ({ doc }) => {
            initializedRef.current = false;
            const columnsMap = getItemMapRoot(doc, 'columns');
            const tasksMap = getItemMapRoot(doc, 'tasks');
            const columnOrderArray = getIdArrayRoot(doc, 'columnOrder');

            const updateReactState = () => {
                setBoard((prev) => {
                    const next = readBoard(doc);
                    for (const id in next.columns) {
                        if (prev.columns[id] && sameColumn(prev.columns[id], next.columns[id]))
                            next.columns[id] = prev.columns[id];
                    }
                    return next;
                });
            };

            // tasks shallow: a card's own edits don't change which ids the board can read.
            columnsMap.observeDeep(updateReactState);
            tasksMap.observe(updateReactState);
            columnOrderArray.observe(updateReactState);
            updateReactState();

            return () => {
                columnsMap.unobserveDeep(updateReactState);
                tasksMap.unobserve(updateReactState);
                columnOrderArray.unobserve(updateReactState);
            };
        },
        onSync: ({ doc }, synced) => {
            if (!synced || initializedRef.current) return;
            initializedRef.current = true;
            // normalizeBoard runs BEFORE the empty-check + seeding, once per pathId.
            normalizeBoard(doc);
            if (doc.getMap('columns').size === 0) {
                initializeDefaultBoard(doc, userEmailRef.current || 'user@localhost').catch(console.error);
            }
        },
    });

    // Seal discrete ops (column add, card delete) as their own undo step — a stopCapturing() bracket
    // stops Y.UndoManager from merging into the previous step within its 500ms captureTimeout (vector's
    // discipline, adopted in U6e). Held in a ref so the `[]`-deps callback reads the live manager.
    const undoManagerRef = useRef(undoManager);
    undoManagerRef.current = undoManager;

    const handleAddColumn = (title: string) => {
        if (!docRef.current) return;
        const doc = docRef.current;
        undoManagerRef.current?.stopCapturing();
        doc.transact(() => {
            const columnId = `column-${nanoid(10)}`;
            const columnsMap = getItemMapRoot(doc, 'columns');
            const columnOrderArray = getIdArrayRoot(doc, 'columnOrder');
            const newColumnMap = new Y.Map();
            newColumnMap.set('id', columnId);
            newColumnMap.set('title', title);
            newColumnMap.set('taskIds', new Y.Array());
            newColumnMap.set('creator', user?.email || '');
            newColumnMap.set('createdAt', Date.now());
            columnsMap.set(columnId, newColumnMap);
            columnOrderArray.push([columnId]);
        });
        undoManagerRef.current?.stopCapturing();
        setIsAddColumnDialogOpen(false);
    };

    const deleteCardFromBoard = useCallback((cardId: string) => {
        if (!docRef.current) return;
        const doc = docRef.current;
        // Walk columns + remove the tasks entry in one transact: single undo step, no orphan
        // column refs. The `.eigenchat` + comments.db row persist for undo / version revert.
        undoManagerRef.current?.stopCapturing();
        doc.transact(() => {
            const columnsMap = getItemMapRoot(doc, 'columns');
            for (const [, columnMap] of columnsMap) {
                const taskIds = getIdArray(columnMap, 'taskIds');
                if (!taskIds) continue;
                const idx = taskIds.toArray().indexOf(cardId);
                if (idx !== -1) {
                    taskIds.delete(idx, 1);
                    break;
                }
            }
            doc.getMap('tasks').delete(cardId);
        });
        undoManagerRef.current?.stopCapturing();
    }, []);

    return {
        board,
        isSynced,
        offline,
        loaded,
        storageUnavailable,
        storageGone,
        unsyncedEdits,
        isAddColumnDialogOpen,
        setIsAddColumnDialogOpen,
        handleAddColumn,
        deleteCardFromBoard,
        yjsDoc,
        undoManager,
        provider,
    };
};
