import {useEffect, useRef, useState} from 'react';
import * as Y from 'yjs';
import {WebsocketProvider} from 'y-websocket';
import {BoardData, ColumnItem, TaskItem} from '../types';
import {nanoid} from 'nanoid';
import {useInitializeBoard} from './useInitializeBoard';
import {normalizeBoard} from '../normalizeBoard';
import {getCollabWebSocketUrl} from "@workspace/lib/api";

/**
 * Minimal Yjs-powered Kanban board hook for collaborative editing
 */
export const useYjsKanbanBoard = (ownerId: string, mountId: string, pathId: string) => {
    // Board state mirrors Yjs document
    const [board, setBoard] = useState<BoardData>({
        tasks: {},
        columns: {},
        columnOrder: [],
    });

    // UI state for dialogs and selection
    const [selectedColumnId, setSelectedColumnId] = useState<string | null>(null);
    const [isAddTaskDialogOpen, setIsAddTaskDialogOpen] = useState(false);
    const [isAddColumnDialogOpen, setIsAddColumnDialogOpen] = useState(false);

    // Yjs doc/provider refs
    const docRef = useRef<Y.Doc | null>(null);
    const providerRef = useRef<WebsocketProvider | null>(null);
    const undoManager = useRef<Y.UndoManager | null>(null);

    const {initializeDefaultBoard} = useInitializeBoard();

    // Helper function to initialize board from JSON to Yjs data
    useEffect(() => {
        const doc = new Y.Doc();
        docRef.current = doc;

        const columnsMap = doc.getMap("columns");
        const tasksMap = doc.getMap("tasks");
        const columnOrderArray = doc.getArray("columnOrder");

        undoManager.current = new Y.UndoManager([columnsMap, tasksMap, columnOrderArray]);

        // Connect to WebSocket provider
        const wsUrl = getCollabWebSocketUrl(ownerId, mountId, pathId);
        const wsProvider = new WebsocketProvider(wsUrl, '', doc, {
            resyncInterval: 5000,
            connect: true,
        });
        providerRef.current = wsProvider;

        // Map Yjs doc to React state
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

        // Observe Yjs changes
        tasksMap.observeDeep(updateReactState);
        columnsMap.observeDeep(updateReactState);
        columnOrderArray.observe(updateReactState);
        updateReactState();

        // Initialize default columns if doc is empty (as a backup mechanism)
        wsProvider.on('sync', (isSynced: boolean) => {
            console.log(isSynced)

            if (isSynced && columnsMap.size === 0) {
                console.log('Sync completed, board is still empty, initializing default structure');
                doc.transact(() => {
                    initializeDefaultBoard(doc, ownerId);
                });
            }
        });

        // Cleanup
        return () => {
            if (providerRef.current) providerRef.current.disconnect();
            if (docRef.current) docRef.current.destroy();
        };
    }, [ownerId, pathId, initializeDefaultBoard]);

    // Dialog handlers
    const handleAddTaskClick = (columnId: string) => {
        setSelectedColumnId(columnId);
        setIsAddTaskDialogOpen(true);
    };

    const handleAddTask = (taskData: Omit<TaskItem, 'id' | 'createdAt'>) => {
        if (!selectedColumnId || !docRef.current) return;
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
            if (taskData.chatId) newTaskMap.set('chatId', taskData.chatId);
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

    // Add new column (mutates Yjs only)
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
        provider: providerRef.current,
        undoManager: undoManager.current,
    };
};
