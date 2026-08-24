import { getCollabWebSocketUrl } from '@workspace/lib/api';
import { useAuth } from '@workspace/lib/auth';
import { useCreateChat } from '@workspace/lib/chat';
import { writeCardToDoc } from '@workspace/lib/comments';
import { EIGEN_STICKIES_COLORS } from '@workspace/lib/constants';
import { nanoid } from 'nanoid';
import { useCallback, useEffect, useRef, useState } from 'react';
import { WebsocketProvider } from 'y-websocket';
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

export const useBoard = (ownerId: string, mountId: string, pathId: string, chatFolderId: string | null) => {
    const [board, setBoard] = useState<BoardData>({ columns: {}, columnOrder: [] });
    const [isSynced, setIsSynced] = useState(false);
    const [isAddColumnDialogOpen, setIsAddColumnDialogOpen] = useState(false);

    const docRef = useRef<Y.Doc | null>(null);
    const providerRef = useRef<WebsocketProvider | null>(null);
    const undoManager = useRef<Y.UndoManager | null>(null);

    const { user } = useAuth();
    const createChat = useCreateChat(ownerId, mountId);
    const createChatRef = useRef(createChat);
    createChatRef.current = createChat;
    const chatFolderIdRef = useRef(chatFolderId);
    chatFolderIdRef.current = chatFolderId;

    const createCardChat = useCallback(async (): Promise<string | undefined> => {
        const folderId = chatFolderIdRef.current;
        if (!folderId) return undefined;
        const result = await createChatRef.current
            .mutateAsync({
                parentId: folderId,
                fileName: `task-${nanoid(10)}`,
            })
            .catch(() => undefined);
        return result?.name;
    }, []);

    const initializeDefaultBoard = useCallback(
        async (doc: Y.Doc, userEmail: string) => {
            const columnsMap = doc.getMap('columns');
            if (columnsMap.size > 0) return;

            const chatName = await createCardChat();

            if (columnsMap.size > 0) return;
            const now = Date.now();

            doc.transact(() => {
                const columnOrderArray = doc.getArray('columnOrder');

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

    useEffect(() => {
        const doc = new Y.Doc();
        docRef.current = doc;

        const columnsMap = doc.getMap('columns');
        const tasksMap = doc.getMap('tasks');
        const columnOrderArray = doc.getArray('columnOrder');

        undoManager.current = new Y.UndoManager([columnsMap, tasksMap, columnOrderArray]);

        const wsUrl = getCollabWebSocketUrl(ownerId, mountId, pathId);
        const wsProvider = new WebsocketProvider(wsUrl, '', doc, {
            resyncInterval: 5000,
            connect: true,
        });
        providerRef.current = wsProvider;

        const updateReactState = () => {
            setBoard((prev) => {
                const columns: Record<string, ColumnItem> = {};
                for (const [columnId, columnMapValue] of columnsMap) {
                    const columnMap = columnMapValue as Y.Map<unknown>;
                    const taskIdsArray = columnMap.get('taskIds') as Y.Array<string>;
                    const next: ColumnItem = {
                        id: columnId,
                        title: (columnMap.get('title') as string) || '',
                        taskIds: taskIdsArray ? (taskIdsArray.toArray() as string[]) : [],
                        creator: (columnMap.get('creator') as string) || '',
                        // Stable fallback — a per-refresh Date.now() would defeat sameColumn for
                        // legacy columns that predate the createdAt field. Nothing renders it.
                        createdAt: (columnMap.get('createdAt') as number) || 0,
                    };
                    const prevColumn = prev.columns[columnId];
                    columns[columnId] = prevColumn && sameColumn(prevColumn, next) ? prevColumn : next;
                }
                return { columns, columnOrder: columnOrderArray.toArray() as string[] };
            });
        };

        columnsMap.observeDeep(updateReactState);
        columnOrderArray.observe(updateReactState);
        updateReactState();

        let initialized = false;
        wsProvider.on('sync', (synced: boolean) => {
            setIsSynced(synced);
            if (synced && !initialized) {
                initialized = true;
                normalizeBoard(doc);
                if (columnsMap.size === 0) {
                    initializeDefaultBoard(doc, user?.email || 'user@localhost').catch(console.error);
                }
            }
        });

        return () => {
            setIsSynced(false);
            // Unregister observers and tear down the UndoManager + provider; the effect re-runs on
            // pathId change without an unmount, so without this the old ones leak (and fire on
            // torn-down state). provider.destroy() before doc.destroy() — it detaches its own doc listener.
            columnsMap.unobserveDeep(updateReactState);
            columnOrderArray.unobserve(updateReactState);
            undoManager.current?.destroy();
            undoManager.current = null;
            wsProvider.destroy();
            doc.destroy();
        };
    }, [ownerId, mountId, pathId, user?.email, initializeDefaultBoard]);

    const handleAddColumn = (title: string) => {
        if (!docRef.current) return;
        const doc = docRef.current;
        doc.transact(() => {
            const columnId = `column-${nanoid(10)}`;
            const columnsMap = doc.getMap('columns');
            const columnOrderArray = doc.getArray('columnOrder');
            const newColumnMap = new Y.Map();
            newColumnMap.set('id', columnId);
            newColumnMap.set('title', title);
            newColumnMap.set('taskIds', new Y.Array());
            newColumnMap.set('creator', user?.email || '');
            newColumnMap.set('createdAt', Date.now());
            columnsMap.set(columnId, newColumnMap);
            columnOrderArray.push([columnId]);
        });
        setIsAddColumnDialogOpen(false);
    };

    const deleteCardFromBoard = useCallback((cardId: string) => {
        if (!docRef.current) return;
        const doc = docRef.current;
        // Walk columns + remove the tasks entry in one transact: single undo step, no orphan
        // column refs. The `.eigenchat` + comments.db row persist for undo / version revert.
        doc.transact(() => {
            const columnsMap = doc.getMap('columns');
            for (const [, columnMapValue] of columnsMap) {
                const columnMap = columnMapValue as Y.Map<unknown>;
                const taskIds = columnMap.get('taskIds') as Y.Array<string> | undefined;
                if (!taskIds) continue;
                const idx = (taskIds.toArray() as string[]).indexOf(cardId);
                if (idx !== -1) {
                    taskIds.delete(idx, 1);
                    break;
                }
            }
            doc.getMap('tasks').delete(cardId);
        });
    }, []);

    return {
        board,
        isSynced,
        isAddColumnDialogOpen,
        setIsAddColumnDialogOpen,
        handleAddColumn,
        deleteCardFromBoard,
        yjsDoc: docRef.current,
        undoManager: undoManager.current,
        provider: providerRef.current,
    };
};
