export interface TaskItem {
  id: string;
  content: string;
}

export interface ColumnItem {
  id: string;
  title: string;
  taskIds: string[];
}

export interface BoardData {
  tasks: Record<string, TaskItem>;
  columns: Record<string, ColumnItem>;
  columnOrder: string[];
}

export type BoardProps = {
  ownerId: string;
  pathId: string;
};
