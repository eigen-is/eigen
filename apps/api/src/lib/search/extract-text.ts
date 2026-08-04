import { isSearchableTextFile } from '@workspace/lib/constants';
import {
    DRIVE_MIME_CHAT,
    DRIVE_MIME_DOC,
    DRIVE_MIME_SHEETS,
    DRIVE_MIME_SLIDES,
    DRIVE_MIME_STICKIES,
    type DrivePath,
} from '@workspace/lib/types/drive';
import { readChatContent } from '../document/chat';
import { COLLAB_DOCUMENT_TYPES } from '../document/collab-types';
import { readStickiesContent, type StickiesContent } from '../document/stickies';
import { runTransformToExtractedText } from '../document/transform/run-transform';
import type { Mount } from '../mount';
import { CONTENT_INDEX_MAX_BYTES } from './limits';

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

// Body text for one indexable path, capped at ~100 KB. Dispatch by mime: the three heavy
// collab types extract inside the transform Worker (extract-render.ts, at background
// priority — nobody waits on a reindex), stickies/chat/plain files are light reads that stay
// here. The drain loop catches and logs, so a refused or failed extract just leaves the row
// dirty for a later drain — there is deliberately no main-thread fallback.
export async function extractText(mount: Mount, path: DrivePath): Promise<string> {
    switch (path.mimeType) {
        case DRIVE_MIME_DOC:
        case DRIVE_MIME_SLIDES:
        case DRIVE_MIME_SHEETS: {
            const documentType = COLLAB_DOCUMENT_TYPES.get(path.mimeType)!;
            return runTransformToExtractedText(
                mount,
                path,
                { kind: 'extract-text', documentType },
                { priority: 'background' },
            );
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
