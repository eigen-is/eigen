import type {DrivePath} from './drive';

export type EigenClipboardTextItem = {
    type: 'text';
    text: string;
    meta?: Record<string, unknown>;
}

export type EigenClipboardImageItem = {
    type: 'image';
    src: string;
    sourcePath?: DrivePath;
    meta?: Record<string, unknown>;
}

export type EigenClipboardItem = EigenClipboardTextItem | EigenClipboardImageItem;

export type EigenClipboardData = {
    version: 1;
    items: EigenClipboardItem[];
}


