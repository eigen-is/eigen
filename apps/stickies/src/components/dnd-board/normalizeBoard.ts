import * as Y from 'yjs';

/**
 * Ensures that each task (card) appears in at most one column's taskIds array.
 * If a task is found in multiple columns, it will only remain in the last column encountered.
 * If a task is found in zero columns, it will be added to the first column (if any).
 *
 * This function mutates the Yjs document directly and is intended to be called
 * inside a Yjs transaction.
 *
 * @param yjsDoc The Yjs document containing the board state
 */
export function normalizeBoard(yjsDoc: Y.Doc) {
    const columnsMap = yjsDoc.getMap('columns');
    const tasksMap = yjsDoc.getMap('tasks');
    const columnIds = Array.from(columnsMap.keys());
    const taskIds = Array.from(tasksMap.keys());

    // Map from taskId to the columns it appears in
    const taskToColumns: Record<string, string[]> = {};

    // Build the mapping
    for (const columnId of columnIds) {
        const columnValue = columnsMap.get(columnId);
        if (!columnValue) continue;
        const column = columnValue as Y.Map<any>;
        const taskIdsArray = column.get('taskIds') as Y.Array<any>;
        if (!taskIdsArray) continue;
        for (const taskId of taskIdsArray.toArray() as string[]) {
            if (!taskToColumns[taskId]) {
                taskToColumns[taskId] = [];
            }
            taskToColumns[taskId].push(columnId);
        }
    }

    // 1. Remove duplicates: For each task in multiple columns, keep only in the last column
    for (const [taskId, columns] of Object.entries(taskToColumns)) {
        if (columns.length <= 1) continue;
        // Remove taskId from all columns except the last
        for (let i = 0; i < columns.length - 1; i++) {
            const colId = columns[i];
            const columnValue = columnsMap.get(colId);
            if (!columnValue) continue;
            const column = columnValue as Y.Map<any>;
            const taskIdsArray = column.get('taskIds') as Y.Array<any>;
            const idx = (taskIdsArray.toArray() as string[]).indexOf(taskId);
            if (idx !== -1) {
                taskIdsArray.delete(idx, 1);
            }
        }
        // Task remains only in the last column
    }

    // 2. Find orphaned tasks (tasks not in any column) and add them to the first column (if any)
    if (columnIds.length > 0) {
        const firstColumnValue = columnsMap.get(columnIds[0]);
        if (firstColumnValue) {
            const firstColumn = firstColumnValue as Y.Map<any>;
            const firstTaskIdsArray = firstColumn.get('taskIds') as Y.Array<any>;
            for (const taskId of taskIds) {
                if (!taskToColumns[taskId] || taskToColumns[taskId].length === 0) {
                    // Add orphaned task to the first column
                    firstTaskIdsArray.push([taskId]);
                }
            }
        }
    }
}
