import { isSearchableTextFile } from '@workspace/lib/constants';
import { VCARD_MAX_BYTES } from '@workspace/lib/constants/contact';
import {
    DRIVE_MIME_CHAT,
    DRIVE_MIME_STICKIES,
    type DrivePath,
    isDocumentType,
    isVCardFile,
} from '@workspace/lib/types/drive';
import { ApiError } from '../core/errors';
import { readChatContent } from '../document/chat';
import { COLLAB_DOCUMENT_TYPES } from '../document/collab-types';
import { readStickiesContent, type StickiesContent } from '../document/stickies';
import { runFileTransformToText, runTransformToExtractedText } from '../document/transform/run-transform';
import type { Mount } from '../mount';
import { parseVCardPreview } from '../preview/vcard-preview';
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

// Body text for one indexable path, capped at ~100 KB. Dispatch by container mime: the three heavy
// collab types extract inside the transform Worker (extract-render.ts, at background
// priority — nobody waits on a reindex), stickies/chat/plain files are light reads that stay
// here. The drain loop catches and logs, so a refused or failed extract just leaves the row
// dirty for a later drain — there is deliberately no main-thread fallback.
export async function extractText(mount: Mount, path: DrivePath): Promise<string> {
    // The container TYPE gates every document branch: mimeType is caller-controlled on upload, so a
    // plain file wearing an eigen mime keeps the raw-bytes read its content deserves instead of
    // being handed to a loader that can only ever fail.
    const containerMime = isDocumentType(path.type) ? path.mimeType : '';
    const documentType = COLLAB_DOCUMENT_TYPES.get(containerMime);
    if (documentType) {
        return runTransformToExtractedText(
            mount,
            path,
            { kind: 'extract-text', documentType },
            { priority: 'background' },
        );
    }
    if (containerMime === DRIVE_MIME_STICKIES) {
        const content = await readStickiesContent(mount, path);
        return collectStickiesText(content, CONTENT_INDEX_MAX_BYTES);
    }
    if (containerMime === DRIVE_MIME_CHAT) return readChatContent(mount, path, CONTENT_INDEX_MAX_BYTES);
    if (!isSearchableTextFile(path.mimeType, path.name)) return '';
    if (isVCardFile(path.mimeType, path.name)) return extractVCardText(mount, path);
    const bytes = await mount.readBytes(path.id, CONTENT_INDEX_MAX_BYTES);
    return bytes ? Buffer.from(bytes).toString() : '';
}

// A .vcf indexes by the contacts it holds: its raw body is mostly base64 photo, and a name folded across
// physical lines isn't there to be matched. The cards come from the same Worker job the preview runs
// (PREVIEWS.md), so they carry that job's ceilings — a file over the import ceiling, and a file the
// decoder refuses, index as nothing rather than staying dirty for every later drain.
async function extractVCardText(mount: Mount, path: DrivePath): Promise<string> {
    if (path.size > VCARD_MAX_BYTES) return '';

    let body: string | null;
    try {
        body = await runFileTransformToText(
            mount,
            path,
            { kind: 'preview', documentType: 'vcard' },
            { priority: 'background' },
        );
    } catch (err) {
        if (err instanceof ApiError && err.status === 422) return '';
        throw err;
    }
    if (!body) return '';

    const parts: string[] = [];
    let total = 0;
    for (const { contact } of parseVCardPreview(body).cards) {
        if (total >= CONTENT_INDEX_MAX_BYTES) break;
        const line = [
            `${contact.firstName} ${contact.lastName}`.trim(),
            ...contact.email,
            contact.company,
            contact.jobTitle,
        ]
            .filter(Boolean)
            .join(' ');
        parts.push(line);
        total += line.length;
    }
    return parts.join(' ');
}
