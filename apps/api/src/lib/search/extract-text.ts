// The text the search index stores for one Drive file. The search drain calls extractText when a file is dirty.
// Documents such as a doc or a sheet extract in the transform process, stickies and chats are read here, a .vcf
// indexes by the names and addresses on its cards, and a plain text file by its first bytes.

import { isSearchableTextFile } from '@workspace/lib/constants';
import { VCARD_MAX_BYTES } from '@workspace/lib/constants/contact';
import { contactFullName } from '@workspace/lib/types/contact';
import type { DrivePath } from '@workspace/lib/types/drive';
import { DRIVE_MIME_CHAT, DRIVE_MIME_STICKIES, isDocumentType } from '@workspace/lib/types/drive';
import { isVCardFile } from '@workspace/lib/types/file-kinds';
import { ApiError } from '../core/errors';
import { readChatContent } from '../document/chat';
import { COLLAB_DOCUMENT_TYPES } from '../document/collab-types';
import type { StickiesContent } from '../document/stickies';
import { readStickiesContent } from '../document/stickies';
import { runFileTransformToText, runTransformToExtractedText } from '../document/transform/run-transform';
import type { Mount } from '../mount';
import { parseVCardPreview } from '../preview/vcard-preview';
import { CONTENT_INDEX_MAX_BYTES } from './limits';

// Nobody waits on a reindex, so the heavy extracts run at background priority. A failed one leaves the row dirty
// for a later drain; there is no main-thread fallback.
export async function extractText(mount: Mount, path: DrivePath): Promise<string> {
    // The container TYPE gates every document branch: mimeType is caller-controlled on upload, so a
    // plain file wearing an eigen mime keeps the raw-bytes read its content deserves instead of
    // being handed to a loader that can only ever fail.
    const containerMime = isDocumentType(path.type) ? path.mimeType : '';
    const documentType = COLLAB_DOCUMENT_TYPES.get(containerMime);
    if (documentType) {
        // A document too large for the transform's memory indexes as nothing, as a vCard the decoder refuses does.
        try {
            return await runTransformToExtractedText(
                mount,
                path,
                { kind: 'extract-text', documentType },
                { priority: 'background' },
            );
        } catch (err) {
            if (err instanceof ApiError && err.status === 413) return '';
            throw err;
        }
    }
    if (containerMime === DRIVE_MIME_STICKIES) {
        const content = await readStickiesContent(mount, path);
        return collectStickiesText(content, CONTENT_INDEX_MAX_BYTES);
    }
    if (containerMime === DRIVE_MIME_CHAT) return readChatContent(mount, path, CONTENT_INDEX_MAX_BYTES);
    if (!isSearchableTextFile(path.mimeType, path.name)) return '';
    if (isVCardFile(path.mimeType, path.name)) return extractVCardText(mount, path);
    const bytes = await mount.readBytes(path.id, CONTENT_INDEX_MAX_BYTES);
    // stream: true holds back a character the cap split, where a plain decode ends on U+FFFD.
    return bytes ? new TextDecoder().decode(bytes, { stream: true }) : '';
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

// A .vcf's raw body is mostly base64 photo, and a name folded across lines isn't there to match, so it indexes by
// its cards. A file over the import ceiling, or one the decoder refuses, indexes as nothing rather than staying
// dirty for every later drain.
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
        const line = [contactFullName(contact), ...contact.email, contact.company, contact.jobTitle]
            .filter(Boolean)
            .join(' ');
        parts.push(line);
        total += line.length;
    }
    return parts.join(' ');
}
