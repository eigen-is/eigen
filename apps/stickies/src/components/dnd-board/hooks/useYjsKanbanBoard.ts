import { useState, useEffect, useRef } from 'react';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { BoardData, TaskItem, ColumnItem } from '../types';
import { nanoid } from 'nanoid';

/**
 * Custom hook for integrating Yjs with Kanban board for collaborative editing
 */
export const useYjsKanbanBoard = (ownerId: string, pathId: string) => {
  // Initialize state that will mirror our Yjs document
  const [board, setBoard] = useState<BoardData>({
    tasks: {},
    columns: {},
    columnOrder: []
  });
  
  // Selected column for dialogs
  const [selectedColumnId, setSelectedColumnId] = useState<string | null>(null);
  const [isAddTaskDialogOpen, setIsAddTaskDialogOpen] = useState(false);
  const [isAddColumnDialogOpen, setIsAddColumnDialogOpen] = useState(false);
  
  // Reference to the Yjs document and shared types
  const docRef = useRef<Y.Doc | null>(null);
  const providerRef = useRef<WebsocketProvider | null>(null);
  
  useEffect(() => {
    // Initialize Yjs document
    const doc = new Y.Doc();
    docRef.current = doc;
    
    // Set up shared data structures
    const boardMap = doc.getMap('board');
    const columnsMap = doc.getMap('columns');
    const tasksMap = doc.getMap('tasks'); 
    const columnOrderArray = doc.getArray('columnOrder');
    
    // Connect to WebSocket provider
    const wsUrl = `${import.meta.env.VITE_API_HOST}/ws/collab/${ownerId}/${pathId}`;
    const slug = '';
    
    const wsProvider = new WebsocketProvider(wsUrl, slug, doc, {
      resyncInterval: 5000,
      connect: true,
    });
    
    providerRef.current = wsProvider;
    
    // Log connection events
    wsProvider.on('status', ({ status }: { status: string }) => {
      console.log(`Kanban WebSocket Status: ${status}`);
    });
    
    wsProvider.on('connection-error', (event: any) => {
      console.error('Kanban WebSocket connection error:', event);
    });
    
    // Convert Yjs data to React state
    const updateReactState = () => {
      const newState: BoardData = {
        tasks: {},
        columns: {},
        columnOrder: columnOrderArray.toArray() as string[]
      };
      
      // Convert tasks
      tasksMap.forEach((taskMapValue, taskId) => {
        // Safely cast to Y.Map
        const taskMap = taskMapValue as Y.Map<any>;
        
        // Extract task data
        newState.tasks[taskId] = {
          id: taskId,
          title: taskMap.get('title') || '',
          description: taskMap.get('description') || '',
          creator: taskMap.get('creator') || '',
          createdAt: taskMap.get('createdAt') || Date.now(),
          comments: Array.isArray(taskMap.get('comments')) 
            ? taskMap.get('comments').map((comment: any) => ({
                id: comment.id,
                text: comment.text,
                author: comment.author,
                createdAt: comment.createdAt
              }))
            : []
        };
      });
      
      // Convert columns
      columnsMap.forEach((columnMapValue, columnId) => {
        // Safely cast to Y.Map
        const columnMap = columnMapValue as Y.Map<any>;
        
        // Get taskIds array, safely cast to array of strings
        const taskIdsArray = columnMap.get('taskIds') as Y.Array<any>;
        const taskIds = taskIdsArray ? taskIdsArray.toArray() as string[] : [];
        
        newState.columns[columnId] = {
          id: columnId,
          title: columnMap.get('title') || '',
          taskIds,
          creator: columnMap.get('creator') || '',
          createdAt: columnMap.get('createdAt') || Date.now()
        };
      });
      
      setBoard(newState);
    };
    
    // Observe changes to update React state
    tasksMap.observeDeep(updateReactState);
    columnsMap.observeDeep(updateReactState);
    columnOrderArray.observe(updateReactState);
    
    // Initial state update
    updateReactState();
    
    // Check if the document is empty and initialize with default columns if needed
    doc.on('sync', (isSynced: boolean) => {
      if (isSynced && columnOrderArray.length === 0) {
        // Initialize with empty "To Do", "In Progress", and "Done" columns
        doc.transact(() => {
          const now = Date.now();
          
          // Create initial columns
          const todoId = `column-${nanoid(6)}`;
          const inProgressId = `column-${nanoid(6)}`;
          const doneId = `column-${nanoid(6)}`;
          
          // To Do column
          const todoColumn = new Y.Map();
          todoColumn.set('id', todoId);
          todoColumn.set('title', 'To Do');
          todoColumn.set('taskIds', new Y.Array());
          todoColumn.set('creator', ownerId);
          todoColumn.set('createdAt', now);
          columnsMap.set(todoId, todoColumn);
          
          // In Progress column
          const inProgressColumn = new Y.Map();
          inProgressColumn.set('id', inProgressId);
          inProgressColumn.set('title', 'In Progress');
          inProgressColumn.set('taskIds', new Y.Array());
          inProgressColumn.set('creator', ownerId);
          inProgressColumn.set('createdAt', now);
          columnsMap.set(inProgressId, inProgressColumn);
          
          // Done column
          const doneColumn = new Y.Map();
          doneColumn.set('id', doneId);
          doneColumn.set('title', 'Done');
          doneColumn.set('taskIds', new Y.Array());
          doneColumn.set('creator', ownerId);
          doneColumn.set('createdAt', now);
          columnsMap.set(doneId, doneColumn);
          
          // Set column order
          columnOrderArray.insert(0, [todoId, inProgressId, doneId]);
        });
      }
    });
    
    // Cleanup function
    return () => {
      if (providerRef.current) {
        providerRef.current.disconnect();
      }
      if (docRef.current) {
        docRef.current.destroy();
      }
    };
  }, [ownerId, pathId]);
  
  // Handle opening the add task dialog
  const handleAddTaskClick = (columnId: string) => {
    setSelectedColumnId(columnId);
    setIsAddTaskDialogOpen(true);
  };
  
  // Handle creating a new task
  const handleAddTask = (taskData: Omit<TaskItem, 'id' | 'comments' | 'creator' | 'createdAt'>) => {
    if (!selectedColumnId || !docRef.current) return;
    
    const doc = docRef.current;
    
    doc.transact(() => {
      // Generate unique ID with timestamp and random component
      const taskId = `task-${nanoid(10)}`;
      const now = Date.now();
      
      // Create task
      const tasksMap = doc.getMap('tasks');
      const columnsMap = doc.getMap('columns');
      
      const newTaskMap = new Y.Map();
      newTaskMap.set('id', taskId);
      newTaskMap.set('title', taskData.title);
      newTaskMap.set('description', taskData.description || '');
      newTaskMap.set('creator', ownerId);
      newTaskMap.set('createdAt', now);
      newTaskMap.set('comments', new Y.Array());
      
      tasksMap.set(taskId, newTaskMap);
      
      // Add task to column
      const columnMapValue = columnsMap.get(selectedColumnId);
      if (columnMapValue) {
        const columnMap = columnMapValue as Y.Map<any>;
        const taskIdsArray = columnMap.get('taskIds') as Y.Array<any>;
        if (taskIdsArray) {
          taskIdsArray.push([taskId]);
        }
      }
    });
    
    // Close dialog
    setIsAddTaskDialogOpen(false);
  };
  
  // Handle creating a new column
  const handleAddColumn = (columnData: Omit<ColumnItem, 'id' | 'taskIds' | 'creator' | 'createdAt'>) => {
    if (!docRef.current) return;
    
    const doc = docRef.current;
    
    doc.transact(() => {
      // Generate unique ID
      const columnId = `column-${nanoid(10)}`;
      const now = Date.now();
      
      // Create column
      const columnsMap = doc.getMap('columns');
      const columnOrderArray = doc.getArray('columnOrder');
      
      const newColumnMap = new Y.Map();
      newColumnMap.set('id', columnId);
      newColumnMap.set('title', columnData.title);
      newColumnMap.set('taskIds', new Y.Array());
      newColumnMap.set('creator', ownerId);
      newColumnMap.set('createdAt', now);
      
      columnsMap.set(columnId, newColumnMap);
      
      // Add to column order
      columnOrderArray.push([columnId]);
    });
    
    // Close dialog
    setIsAddColumnDialogOpen(false);
  };
  
  return {
    board,
    setBoard, // Mainly for compatibility with existing code
    selectedColumnId,
    isAddTaskDialogOpen,
    setIsAddTaskDialogOpen,
    isAddColumnDialogOpen,
    setIsAddColumnDialogOpen,
    handleAddTaskClick,
    handleAddTask,
    handleAddColumn,
    // Direct access to Yjs structures for advanced operations
    yjsDoc: docRef.current,
    provider: providerRef.current,
  };
};
