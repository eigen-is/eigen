// What a host passes the Workbook: the sheets, whether the person may edit, and the hooks it calls back on a
// selection, a comment or a chart, with the defaults for what it leaves out.

import type { useCommentLifecycle } from '@workspace/lib/comments';
import type { Sheet as LibSheet, SheetChart, SheetFloatingItem } from '@workspace/lib/sheets';
import type { CommentEntry } from '@workspace/lib/types/chat';
import type { EigenClipboardImageItem } from '@workspace/lib/types/clipboard';
import type { CommentCard } from '@workspace/lib/types/comments';
import type { DrivePath } from '@workspace/lib/types/drive';
import type { Selection } from './types';

export type CommentInfo = {
    card: CommentCard;
    entry: CommentEntry | undefined;
    indicatorColor: string | null;
};

// The selected chart, on the current sheet; every sheet's name, for its data range; the categories and series
// names its range resolves to, which name a pie's slices and the series rows; and whether its resolved data has
// more points than the sketch draws.
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
    resolveImageUrl?: (mediaName: string) => string | null;
    // The media resolver's isMediaMissing: such an image draws as missing.
    isImageMissing?: (mediaName: string) => boolean;
    // Undefined for an upload still pending, whose copy then carries no source path.
    resolveImagePath?: (mediaName: string) => DrivePath | undefined;
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
    // Keep aspect ratio for the selected object's corner grips. The app owns it, so its panel checkbox shows the same.
    aspectLocked?: boolean;
};

export const defaultSettings: Required<Settings> = {
    data: [],
    allowEdit: true,
    hooks: {},
    aspectLocked: false,
};
