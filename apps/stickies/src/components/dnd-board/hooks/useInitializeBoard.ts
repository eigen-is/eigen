import {useCallback} from 'react';
import * as Y from 'yjs';
import {nanoid} from 'nanoid';
import {useAuth} from '@workspace/lib/auth';

// Default board structure with predefined columns and an example task
const DEFAULT_BOARD_STRUCTURE = {
    columns: [
        {id: '', title: 'To Do', taskIds: []},
        {id: '', title: 'In Progress', taskIds: []},
        {id: '', title: 'Done', taskIds: []}
    ],
    tasks: [
        {
            id: '',
            title: 'Welcome to stickies!',
            description: 'Drag this sticky to another column to get started. You can add more stickies with the "Add a sticky" button.'
        }
    ]
};

/**
 * Custom hook for initializing a Yjs Kanban board with default structure
 */
export const useInitializeBoard = () => {
    const {user} = useAuth();

    const initializeDefaultBoard = useCallback(
        (
            doc: Y.Doc,
            userEmail: string = user?.email || 'user@eigen.is',
            emptyCheck: boolean = true
        ): boolean => {
            const columnsMap = doc.getMap('columns');
            const tasksMap = doc.getMap('tasks');
            const columnOrderArray = doc.getArray('columnOrder');

            // Skip initialization if board already has columns and emptyCheck is true
            if (emptyCheck && columnOrderArray.length > 0) {
                console.log('Board already has columns, skipping initialization');
                return false;
            }

            const now = Date.now();
            const columnIds: string[] = [];
            let firstTaskId = '';

            try {
                // Create task first
                const taskId = `task-${nanoid(6)}`;
                firstTaskId = taskId;

                const taskYMap = new Y.Map();
                taskYMap.set('id', taskId);
                taskYMap.set('title', DEFAULT_BOARD_STRUCTURE.tasks[0].title);
                taskYMap.set('description', DEFAULT_BOARD_STRUCTURE.tasks[0].description);
                taskYMap.set('creator', userEmail);
                taskYMap.set('createdAt', now);

                tasksMap.set(taskId, taskYMap);

                // Create columns
                for (const [index, column] of DEFAULT_BOARD_STRUCTURE.columns.entries()) {
                    const columnId = `column-${nanoid(6)}`;
                    columnIds.push(columnId);

                    const columnYMap = new Y.Map();
                    columnYMap.set('id', columnId);
                    columnYMap.set('title', column.title);

                    // Create taskIds array - add the example task to the first column
                    const taskIds = new Y.Array();
                    if (index === 0) {
                        taskIds.push([firstTaskId]);
                    }
                    columnYMap.set('taskIds', taskIds);

                    columnYMap.set('creator', userEmail);
                    columnYMap.set('createdAt', now);

                    columnsMap.set(columnId, columnYMap);
                }

                // Add column order array
                columnOrderArray.insert(0, columnIds);

                console.log('Default board initialized with columns:', columnIds);
                console.log('Added example task:', firstTaskId);
                return true;
            } catch (error) {
                console.error('Error initializing default board:', error);
                return false;
            }
        },
        []
    );

    return {
        initializeDefaultBoard
    };
};
