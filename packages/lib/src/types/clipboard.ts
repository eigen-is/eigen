export type EigenClipboardTextItem = {
    type: 'text';
    text: string;
    meta?: Record<string, unknown>;
};

export type EigenClipboardImageItem = {
    type: 'image';
    mediaName: string;
    sourcePathId: string;
    sourceParentId: string | null;
    sourceOwnerId: string;
    sourceMountId: string;
    meta?: Record<string, unknown>;
};

export type EigenClipboardItem = EigenClipboardTextItem | EigenClipboardImageItem;

export type EigenClipboardData = {
    version: 1;
    items: EigenClipboardItem[];
};
