import * as Y from 'yjs';

export function normalizeBoard(yjsDoc: Y.Doc) {
    const columnsMap = yjsDoc.getMap('columns');
    const tasksMap = yjsDoc.getMap('tasks');
    const columnIds = Array.from(columnsMap.keys());
    const taskIds = Array.from(tasksMap.keys());

    const taskToColumns: Record<string, string[]> = {};

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

    for (const [taskId, columns] of Object.entries(taskToColumns)) {
        if (columns.length <= 1) continue;
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
    }

    if (columnIds.length > 0) {
        const firstColumnValue = columnsMap.get(columnIds[0]);
        if (firstColumnValue) {
            const firstColumn = firstColumnValue as Y.Map<any>;
            const firstTaskIdsArray = firstColumn.get('taskIds') as Y.Array<any>;
            for (const taskId of taskIds) {
                if (!taskToColumns[taskId] || taskToColumns[taskId].length === 0) {
                    firstTaskIdsArray.push([taskId]);
                }
            }
        }
    }
}
