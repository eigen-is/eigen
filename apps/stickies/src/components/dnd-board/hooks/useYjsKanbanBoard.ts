import {useCallback, useEffect, useRef, useState} from 'react';
import * as Y from 'yjs';
import {WebsocketProvider} from 'y-websocket';
import {BoardData, ColumnItem, TaskItem} from '../types';
import {nanoid} from 'nanoid';
import {normalizeBoard} from '../normalizeBoard';
import {getCollabWebSocketUrl} from "@workspace/lib/api";
import {useAuth} from "@workspace/lib/auth";
import {useCreateChat} from "@workspace/lib/chat";
import type {DrivePath} from "@workspace/lib/types/drive";

const DEFAULT_COLUMNS = ['To Do', 'In Progress', 'Done'];
const WELCOME_TASK = {
    title: 'Welcome to stickies!',
    description: 'Drag this sticky to another column to get started. You can add more stickies with the "Add a sticky" button.',
};

export const useYjsKanbanBoard = (ownerId: string, mountId: string, pathId: string, chatFolderId: string | null) => {
    const [board, setBoard] = useState<BoardData>({tasks: {}, columns: {}, columnOrder: []});
    const [selectedColumnId, setSelectedColumnId] = useState<string | null>(null);
    const [isAddTaskDialogOpen, setIsAddTaskDialogOpen] = useState(false);
    const [isAddColumnDialogOpen, setIsAddColumnDialogOpen] = useState(false);

    const docRef = useRef<Y.Doc | null>(null);
    const providerRef = useRef<WebsocketProvider | null>(null);
    const undoManager = useRef<Y.UndoManager | null>(null);

    const {user} = useAuth();
    const createChat = useCreateChat(ownerId, mountId);
    const createChatRef = useRef(createChat);
    createChatRef.current = createChat;
    const chatFolderIdRef = useRef(chatFolderId);
    chatFolderIdRef.current = chatFolderId;

    const createTaskChat = useCallback(async (): Promise<string | undefined> => {
        const folderId = chatFolderIdRef.current;
        if (!folderId) return undefined;
        try {
            const result = await createChatRef.current.mutateAsync({parentId: folderId, fileName: `task-${Date.now()}`});
            return (result as DrivePath)?.id;
        } catch (e) {
            console.error('Failed to create chat for task:', e);
            return undefined;
        }
    }, []);

    const initializeDefaultBoard = useCallback(async (doc: Y.Doc, userEmail: string) => {
        const columnsMap = doc.getMap('columns');
        if (columnsMap.size > 0) return;

        const chatId = await createTaskChat();
        const now = Date.now();

        doc.transact(() => {
            const tasksMap = doc.getMap('tasks');
            const columnOrderArray = doc.getArray('columnOrder');

            const taskId = `task-${nanoid(6)}`;
            const taskYMap = new Y.Map();
            taskYMap.set('id', taskId);
            taskYMap.set('title', WELCOME_TASK.title);
            taskYMap.set('description', WELCOME_TASK.description);
            taskYMap.set('creator', userEmail);
            taskYMap.set('createdAt', now);
            if (chatId) taskYMap.set('chatId', chatId);
            tasksMap.set(taskId, taskYMap);

            const columnIds: string[] = [];
            for (const [index, title] of DEFAULT_COLUMNS.entries()) {
                const columnId = `column-${nanoid(6)}`;
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
    }, [createTaskChat]);

    useEffect(() => {
        const doc = new Y.Doc();
        docRef.current = doc;

        const columnsMap = doc.getMap("columns");
        const tasksMap = doc.getMap("tasks");
        const columnOrderArray = doc.getArray("columnOrder");

        undoManager.current = new Y.UndoManager([columnsMap, tasksMap, columnOrderArray]);

        const wsUrl = getCollabWebSocketUrl(ownerId, mountId, pathId);
        const wsProvider = new WebsocketProvider(wsUrl, '', doc, {
            resyncInterval: 5000,
            connect: true,
        });
        providerRef.current = wsProvider;

        const updateReactState = () => {
            normalizeBoard(doc);
            const newState: BoardData = {
                tasks: {},
                columns: {},
                columnOrder: columnOrderArray.toArray() as string[],
            };
            for (const [taskId, taskMapValue] of tasksMap) {
                const taskMap = taskMapValue as Y.Map<any>;
                newState.tasks[taskId] = {
                    id: taskId,
                    title: taskMap.get('title') || '',
                    description: taskMap.get('description') || '',
                    creator: taskMap.get('creator') || '',
                    createdAt: taskMap.get('createdAt') || Date.now(),
                    chatId: taskMap.get('chatId') || undefined,
                };
            }
            for (const [columnId, columnMapValue] of columnsMap) {
                const columnMap = columnMapValue as Y.Map<any>;
                const taskIdsArray = columnMap.get('taskIds') as Y.Array<any>;
                const taskIds = taskIdsArray ? taskIdsArray.toArray() as string[] : [];
                newState.columns[columnId] = {
                    id: columnId,
                    title: columnMap.get('title') || '',
                    taskIds,
                    creator: columnMap.get('creator') || '',
                    createdAt: columnMap.get('createdAt') || Date.now()
                };
            }
            setBoard(newState);
        };

        tasksMap.observeDeep(updateReactState);
        columnsMap.observeDeep(updateReactState);
        columnOrderArray.observe(updateReactState);
        updateReactState();

        wsProvider.on('sync', (isSynced: boolean) => {
            if (isSynced && columnsMap.size === 0) {
                initializeDefaultBoard(doc, user?.email || 'user@eigen.is');
            }
        });

        return () => {
            if (providerRef.current) providerRef.current.disconnect();
            if (docRef.current) docRef.current.destroy();
        };
    }, [ownerId, mountId, pathId, user?.email, initializeDefaultBoard]);

    const handleAddTaskClick = (columnId: string) => {
        setSelectedColumnId(columnId);
        setIsAddTaskDialogOpen(true);
    };

    const handleAddTask = async (taskData: Omit<TaskItem, 'id' | 'createdAt' | 'chatId'>) => {
        if (!selectedColumnId || !docRef.current) return;
        const chatId = await createTaskChat();
        const doc = docRef.current;
        doc.transact(() => {
            const taskId = `task-${nanoid(10)}`;
            const now = Date.now();
            const tasksMap = doc.getMap('tasks');
            const columnsMap = doc.getMap('columns');
            const newTaskMap = new Y.Map();
            newTaskMap.set('id', taskId);
            newTaskMap.set('title', taskData.title);
            newTaskMap.set('description', taskData.description || '');
            newTaskMap.set('creator', taskData.creator);
            newTaskMap.set('createdAt', now);
            if (chatId) newTaskMap.set('chatId', chatId);
            tasksMap.set(taskId, newTaskMap);
            const columnMapValue = columnsMap.get(selectedColumnId);
            if (columnMapValue) {
                const columnMap = columnMapValue as Y.Map<any>;
                const taskIdsArray = columnMap.get('taskIds') as Y.Array<any>;
                if (taskIdsArray) taskIdsArray.push([taskId]);
            }
        });
        setIsAddTaskDialogOpen(false);
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
        isAddTaskDialogOpen,
        setIsAddTaskDialogOpen,
        isAddColumnDialogOpen,
        setIsAddColumnDialogOpen,
        handleAddTaskClick,
        handleAddTask,
        handleAddColumn,
        yjsDoc: docRef.current,
        undoManager: undoManager.current,
    };
};
