// What a host passes the Workbook: the sheets, whether the person may edit, the comment cards the grid marks, and the
// hooks it calls back on a selection, a comment or a chart.

import type { useCommentLifecycle } from '@workspace/lib/comments';
import type { Sheet as LibSheet, SheetChart, SheetFloatingItem } from '@workspace/lib/sheets';
import type { CommentEntry } from '@workspace/lib/types/chat';
import type { EigenClipboardImageItem } from '@workspace/lib/types/clipboard';
import type { CommentCard } from '@workspace/lib/types/comments';
import type { Selection } from './types';

export type CommentInfo = {
    card: CommentCard;
    entry: CommentEntry | undefined;
};

// The selected chart with the data its range resolves to, for the chart panel.
export type ChartPanelState = {
    chart: SheetChart;
    sheetId: string;
    sheets: { id: string; name: string }[];
    categories: string[];
    seriesNames: string[];
    sketchCapped: boolean;
};

export type Hooks = {
    afterSelectionChange?: (sheetId: string, selection: Selection) => void;
    onAddComment?: (row: number, column: number) => void;
    onDeleteComment?: (row: number, column: number) => void;
    commentLifecycle?: ReturnType<typeof useCommentLifecycle>;
    getCommentInfo?: (row: number, column: number) => CommentInfo | null;
    onInsertImage?: () => void;
    onPasteEigenImage?: (item: EigenClipboardImageItem) => void;
    onPasteImageFile?: (file: File) => void;
    // A pasted svg with no image items comes through onPasteImageFile instead.
    onPasteSvgFile?: (svg: string, imageItems: EigenClipboardImageItem[]) => void;
    // The item is one reference per record, so the app's setState bails while nothing changed.
    onActiveObjectChange?: (item: SheetFloatingItem | null) => void;
    onChartPanelChange?: (panel: ChartPanelState | null) => void;
};

export type Settings = {
    allowEdit?: boolean;
    // The stored sheets the Workbook mounts on. A sheet without an id gets one there.
    data: LibSheet[];
    hooks?: Hooks;
    // The cards by id. The grid repaints when this object changes, so a host passes a new one only with new cards.
    commentCards?: Record<string, CommentCard>;
    // Keep aspect ratio for the selected object's corner grips. The app owns it, so its panel checkbox shows the same.
    aspectLocked?: boolean;
};
