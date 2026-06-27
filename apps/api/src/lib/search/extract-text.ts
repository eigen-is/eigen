import type { JSONContent } from '@tiptap/core';
import { isSearchableTextFile } from '@workspace/lib/constants';
import type { Sheet } from '@workspace/lib/sheets';
import type { DeckData } from '@workspace/lib/slides';
import {
    DRIVE_MIME_CHAT,
    DRIVE_MIME_DOC,
    DRIVE_MIME_SHEETS,
    DRIVE_MIME_SLIDES,
    DRIVE_MIME_STICKIES,
    type DrivePath,
} from '@workspace/lib/types/drive';
import { readChatContent } from '../document/chat';
import { readEigendocContent } from '../document/doc';
import { readSheetsContent } from '../document/sheets';
import { readSlidesContent } from '../document/slides';
import { readStickiesContent, type StickiesContent } from '../document/stickies';
import type { Mount } from '../mount';

export const CONTENT_INDEX_MAX_BYTES = 100_000;

export function collectProseMirrorText(node: JSONContent, cap: number): string {
    const parts: string[] = [];
    let total = 0;
    const walk = (n: JSONContent): boolean => {
        if (total >= cap) return false;
        if (typeof n.text === 'string') {
            parts.push(n.text);
            total += n.text.length;
            if (total >= cap) return false;
        }
        if (Array.isArray(n.content)) {
            for (const child of n.content) {
                if (!walk(child)) return false;
            }
        }
        return true;
    };
    walk(node);
    return parts.join(' ');
}

export function collectSlidesText(deck: DeckData, cap: number): string {
    const parts: string[] = [];
    let total = 0;
    for (const slideId of deck.slideOrder) {
        const slide = deck.slides[slideId];
        if (!slide) continue;
        for (const objId of slide.objectIds) {
            const obj = deck.objects[objId];
            if (obj?.type === 'text' && typeof obj.text === 'string') {
                parts.push(obj.text);
                total += obj.text.length;
                if (total >= cap) return parts.join(' ');
            }
        }
    }
    return parts.join(' ');
}

export function collectSheetsText(sheets: Sheet[], cap: number): string {
    const parts: string[] = [];
    let total = 0;
    for (const sheet of sheets) {
        for (const cd of sheet.celldata ?? []) {
            const cell = cd.v;
            if (!cell) continue;
            const display = cell.m ?? cell.v;
            if (display == null) continue;
            const s = String(display);
            parts.push(s);
            total += s.length;
            if (total >= cap) return parts.join(' ');
        }
    }
    return parts.join(' ');
}

export function collectStickiesText(content: StickiesContent, cap: number): string {
    const parts: string[] = [];
    let total = 0;
    const push = (s?: string) => {
        if (s && total < cap) {
            parts.push(s);
            total += s.length;
        }
    };
    for (const column of content.columns) push(column.title);
    for (const task of content.tasks) {
        push(task.title);
        push(task.description);
    }
    return parts.join(' ');
}

// Body text for one indexable path, capped at ~100 KB. Dispatch by mime; reuse the shared
// lib/document loaders (so search's "document text" can't drift from preview/export). The
// drain loop catches and logs, so a loader that throws on a malformed container (missing
// data.db) just leaves it unindexed.
export async function extractText(mount: Mount, path: DrivePath): Promise<string> {
    switch (path.mimeType) {
        case DRIVE_MIME_DOC: {
            const { json } = await readEigendocContent(mount, path);
            return collectProseMirrorText(json, CONTENT_INDEX_MAX_BYTES);
        }
        case DRIVE_MIME_SLIDES: {
            const { deck } = await readSlidesContent(mount, path);
            return collectSlidesText(deck, CONTENT_INDEX_MAX_BYTES);
        }
        case DRIVE_MIME_SHEETS: {
            const sheets = await readSheetsContent(mount, path);
            return collectSheetsText(sheets, CONTENT_INDEX_MAX_BYTES);
        }
        case DRIVE_MIME_STICKIES: {
            const content = await readStickiesContent(mount, path);
            return collectStickiesText(content, CONTENT_INDEX_MAX_BYTES);
        }
        case DRIVE_MIME_CHAT:
            return readChatContent(mount, path, CONTENT_INDEX_MAX_BYTES);
        default: {
            if (!isSearchableTextFile(path.mimeType, path.name)) return '';
            const file = await mount.readRange(path.id, 0, CONTENT_INDEX_MAX_BYTES);
            return file ? await file.text() : '';
        }
    }
}
