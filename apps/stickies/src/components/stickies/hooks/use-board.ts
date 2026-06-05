import { getCollabWebSocketUrl } from '@workspace/lib/api';
import { useAuth } from '@workspace/lib/auth';
import { useCreateChat } from '@workspace/lib/chat';
import { EIGEN_STICKIES_COLORS } from '@workspace/lib/constants';
import type { CommentCard } from '@workspace/lib/types/comments';
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

// Reuse the previous card object when its fields are unchanged, so memoized
// cards skip re-rendering when an edit elsewhere on the board rebuilds state.
function sameCard(a: CommentCard, b: CommentCard): boolean {
    return (
        a.title === b.title &&
        a.description === b.description &&
        a.color === b.color &&
        a.chatName === b.chatName &&
        a.creator === b.creator &&
        a.createdAt === b.createdAt
    );
}

export const useBoard = (ownerId: string, mountId: string, pathId: string, chatFolderId: string | null) => {
    const [board, setBoard] = useState<BoardData>({ tasks: {}, columns: {}, columnOrder: [] });
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
                const tasksMap = doc.getMap('tasks');
                const columnOrderArray = doc.getArray('columnOrder');

                const taskId = `task-${nanoid(10)}`;
                const taskYMap = new Y.Map();
                taskYMap.set('id', taskId);
                taskYMap.set('title', WELCOME_CARD.title);
                taskYMap.set('description', WELCOME_CARD.description);
                taskYMap.set('color', EIGEN_STICKIES_COLORS[0][1].value);
                if (chatName) taskYMap.set('chatName', chatName);
                tasksMap.set(taskId, taskYMap);

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
                const tasks: Record<string, CommentCard> = {};
                for (const [taskId, taskMapValue] of tasksMap) {
                    const taskMap = taskMapValue as Y.Map<unknown>;
                    const title = taskMap.get('title');
                    const description = taskMap.get('description');
                    const color = taskMap.get('color');
                    const chatName = taskMap.get('chatName');
                    const creator = taskMap.get('creator');
                    const createdAt = taskMap.get('createdAt');
                    const next: CommentCard = {
                        id: taskId,
                        title: typeof title === 'string' ? title : '',
                        description: typeof description === 'string' ? description : '',
                        color: typeof color === 'string' ? color : undefined,
                        chatName: typeof chatName === 'string' ? chatName : undefined,
                        creator: typeof creator === 'string' ? creator : undefined,
                        createdAt: typeof createdAt === 'number' ? createdAt : undefined,
                    };
                    const prevTask = prev.tasks[taskId];
                    tasks[taskId] = prevTask && sameCard(prevTask, next) ? prevTask : next;
                }
                const columns: Record<string, ColumnItem> = {};
                for (const [columnId, columnMapValue] of columnsMap) {
                    const columnMap = columnMapValue as Y.Map<unknown>;
                    const taskIdsArray = columnMap.get('taskIds') as Y.Array<string>;
                    const taskIds = taskIdsArray ? (taskIdsArray.toArray() as string[]) : [];
                    columns[columnId] = {
                        id: columnId,
                        title: (columnMap.get('title') as string) || '',
                        taskIds,
                        creator: (columnMap.get('creator') as string) || '',
                        createdAt: (columnMap.get('createdAt') as number) || Date.now(),
                    };
                }
                return { tasks, columns, columnOrder: columnOrderArray.toArray() as string[] };
            });
        };

        tasksMap.observeDeep(updateReactState);
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
            tasksMap.unobserveDeep(updateReactState);
            columnsMap.unobserveDeep(updateReactState);
            columnOrderArray.unobserve(updateReactState);
            undoManager.current?.destroy();
            undoManager.current = null;
            wsProvider.destroy();
            doc.destroy();
        };
    }, [ownerId, mountId, pathId, user?.email, initializeDefaultBoard]);

    const handleAddColumn = (columnData: Omit<ColumnItem, 'id' | 'taskIds' | 'createdAt'>) => {
        if (!docRef.current) return;
        const doc = docRef.current;
        doc.transact(() => {
            const columnId = `column-${nanoid(10)}`;
            const now = Date.now();
            const columnsMap = doc.getMap('columns');
            const columnOrderArray = doc.getArray('columnOrder');
            const newColumnMap = new Y.Map();
            newColumnMap.set('id', columnId);
            newColumnMap.set('title', columnData.title);
            newColumnMap.set('taskIds', new Y.Array());
            newColumnMap.set('creator', columnData.creator);
            newColumnMap.set('createdAt', now);
            columnsMap.set(columnId, newColumnMap);
            columnOrderArray.push([columnId]);
        });
        setIsAddColumnDialogOpen(false);
    };

    const deleteCardFromBoard = useCallback((cardId: string) => {
        if (!docRef.current) return;
        const doc = docRef.current;
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
        docRef,
    };
};
