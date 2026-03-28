import { getCollabWebSocketUrl } from '@workspace/lib/api';
import { useAuth } from '@workspace/lib/auth';
import { useCreateChat } from '@workspace/lib/chat';
import { EIGEN_STICKIES_COLORS } from '@workspace/lib/constants';
import { nanoid } from 'nanoid';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { WebsocketProvider } from 'y-websocket';
import * as Y from 'yjs';
import { normalizeBoard } from '../normalize-board';
import type { BoardData, CardItem, ColumnItem } from '../types';

const DEFAULT_COLUMNS = ['To Do', 'In Progress', 'Done'];
const WELCOME_CARD = {
    title: 'Welcome to stickies!',
    description:
        'Drag this sticky to another column to get started. You can add more stickies with the "Add a sticky" button.',
};

export const useBoard = (ownerId: string, mountId: string, pathId: string, chatFolderId: string | null) => {
    const [board, setBoard] = useState<BoardData>({ tasks: {}, columns: {}, columnOrder: [] });
    const [selectedColumnId, setSelectedColumnId] = useState<string | null>(null);
    const [isAddCardDialogOpen, setIsAddCardDialogOpen] = useState(false);
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
        try {
            const result = await createChatRef.current.mutateAsync({
                parentId: folderId,
                fileName: `task-${nanoid(10)}`,
            });
            return result?.name;
        } catch (_e) {
            toast.error('Failed to create chat for card');
            return undefined;
        }
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
                taskYMap.set('creator', userEmail);
                taskYMap.set('createdAt', now);
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
            const newState: BoardData = {
                tasks: {},
                columns: {},
                columnOrder: columnOrderArray.toArray() as string[],
            };
            for (const [taskId, taskMapValue] of tasksMap) {
                const taskMap = taskMapValue as Y.Map<unknown>;
                newState.tasks[taskId] = {
                    id: taskId,
                    title: (taskMap.get('title') as string) || '',
                    description: (taskMap.get('description') as string) || '',
                    color: (taskMap.get('color') as string) || '',
                    creator: (taskMap.get('creator') as string) || '',
                    createdAt: (taskMap.get('createdAt') as number) || Date.now(),
                    chatName: (taskMap.get('chatName') as string | undefined) || undefined,
                };
            }
            for (const [columnId, columnMapValue] of columnsMap) {
                const columnMap = columnMapValue as Y.Map<unknown>;
                const taskIdsArray = columnMap.get('taskIds') as Y.Array<string>;
                const taskIds = taskIdsArray ? (taskIdsArray.toArray() as string[]) : [];
                newState.columns[columnId] = {
                    id: columnId,
                    title: (columnMap.get('title') as string) || '',
                    taskIds,
                    creator: (columnMap.get('creator') as string) || '',
                    createdAt: (columnMap.get('createdAt') as number) || Date.now(),
                };
            }
            setBoard(newState);
        };

        tasksMap.observeDeep(updateReactState);
        columnsMap.observeDeep(updateReactState);
        columnOrderArray.observe(updateReactState);
        updateReactState();

        let initialized = false;
        wsProvider.on('sync', (isSynced: boolean) => {
            if (isSynced && !initialized) {
                initialized = true;
                normalizeBoard(doc);
                if (columnsMap.size === 0) {
                    initializeDefaultBoard(doc, user?.email || 'user@localhost').catch((_e) =>
                        toast.error('Failed to initialize board'),
                    );
                }
            }
        });

        return () => {
            if (providerRef.current) providerRef.current.disconnect();
            if (docRef.current) docRef.current.destroy();
        };
    }, [ownerId, mountId, pathId, user?.email, initializeDefaultBoard]);

    const handleAddCardClick = (columnId: string) => {
        setSelectedColumnId(columnId);
        setIsAddCardDialogOpen(true);
    };

    const handleAddCard = async (cardData: Omit<CardItem, 'id' | 'createdAt' | 'chatName'>) => {
        if (!selectedColumnId || !docRef.current) return;
        const chatName = await createCardChat();
        const doc = docRef.current;
        doc.transact(() => {
            const taskId = `task-${nanoid(10)}`;
            const now = Date.now();
            const tasksMap = doc.getMap('tasks');
            const columnsMap = doc.getMap('columns');
            const newTaskMap = new Y.Map();
            newTaskMap.set('id', taskId);
            newTaskMap.set('title', cardData.title);
            newTaskMap.set('description', cardData.description || '');
            if (cardData.color) newTaskMap.set('color', cardData.color);
            newTaskMap.set('creator', cardData.creator);
            newTaskMap.set('createdAt', now);
            if (chatName) newTaskMap.set('chatName', chatName);
            tasksMap.set(taskId, newTaskMap);
            const columnMapValue = columnsMap.get(selectedColumnId);
            if (columnMapValue) {
                const columnMap = columnMapValue as Y.Map<unknown>;
                const taskIdsArray = columnMap.get('taskIds') as Y.Array<string>;
                if (taskIdsArray) taskIdsArray.push([taskId]);
            }
        });
        setIsAddCardDialogOpen(false);
    };

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

    return {
        board,
        selectedColumnId,
        isAddCardDialogOpen,
        setIsAddCardDialogOpen,
        isAddColumnDialogOpen,
        setIsAddColumnDialogOpen,
        handleAddCardClick,
        handleAddCard,
        handleAddColumn,
        yjsDoc: docRef.current,
        undoManager: undoManager.current,
    };
};
