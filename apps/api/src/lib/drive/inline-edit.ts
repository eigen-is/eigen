// The server side of Drive's inline text editor. getEditableContent reads a text file for the editor:
// its edit mode, its text with any markdown frontmatter split off, and the etag a save sends back.
// saveEditableContent writes a save back, guarded by that etag, and answers a conflict when the file
// changed since. The editor routes call both, on the owner's Drive or a SharedDrive.

import { getBytesTextPreviewMode } from '@workspace/lib/constants';
import { DRIVE_TYPE_FILE } from '@workspace/lib/types';
import type { DrivePath, EditorSaveResult, FileEditorContent } from '@workspace/lib/types/drive';
import { enforceMountQuota } from '../config/enforcement';
import { ApiError, computeEtag, StaleWriteError } from '../core';
import type { Mount } from '../mount';
import type { User } from '../user';
import type { DriveLike } from './get-drive';

export const MAX_INLINE_EDIT_SIZE = 5 * 1024 * 1024;

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;

function extractFrontmatter(content: string): { frontmatter: string | null; body: string } {
    const match = content.match(FRONTMATTER_RE);
    if (match) return { frontmatter: match[1], body: match[2] };
    return { frontmatter: null, body: content };
}

function reattachFrontmatter(body: string, frontmatter: string | null): string {
    if (!frontmatter) return body;
    return `---\n${frontmatter}\n---\n${body}`;
}

export async function getEditableContent(mount: Mount, path: DrivePath): Promise<FileEditorContent> {
    if (path.type !== DRIVE_TYPE_FILE) throw new ApiError(404, 'File not found');

    const editMode = getBytesTextPreviewMode(path.mimeType, path.name);
    if (!editMode) throw new ApiError(400, 'File type not supported for inline editing');
    if (path.size > MAX_INLINE_EDIT_SIZE) throw new ApiError(413, 'File too large for inline editing');

    const bytes = await mount.readBytes(path.id);
    if (!bytes) throw new ApiError(404, 'File content not found');

    let content: string;
    try {
        content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
        throw new ApiError(400, 'File contains invalid UTF-8 encoding');
    }

    const { frontmatter, body } =
        editMode === 'markdown'
            ? extractFrontmatter(content)
            : {
                  frontmatter: null,
                  body: content,
              };
    return { editMode, content: body, frontmatter, mimeType: path.mimeType, etag: computeEtag(path) };
}

type EditorSave = { content: string; frontmatter?: string; expectedEtag?: string; force?: boolean };

export async function saveEditableContent(
    drive: DriveLike,
    user: User,
    file: { ownerId: string; mountId: string; pathId: string },
    save: EditorSave,
): Promise<EditorSaveResult> {
    const { ownerId, mountId, pathId } = file;
    const { path } = await drive.resolveFile(mountId, pathId);
    if (!(await drive.canWrite(mountId, pathId, user))) throw new ApiError(403, 'No write permission');
    if (path.type !== DRIVE_TYPE_FILE) throw new ApiError(404, 'File not found');
    // The same gate as getEditableContent, or a writer could overwrite a binary, such as a container's data.db.
    if (!getBytesTextPreviewMode(path.mimeType, path.name)) {
        throw new ApiError(400, 'File type not supported for inline editing');
    }
    const data = Buffer.from(reattachFrontmatter(save.content, save.frontmatter ?? null), 'utf-8');
    // The same cap as getEditableContent, or the next read of the file would refuse it.
    if (data.length > MAX_INLINE_EDIT_SIZE) throw new ApiError(413, 'File too large for inline editing');

    // Without force a save needs the etag it loaded. A tab opened before the editor sent one has none, and
    // gets the conflict dialog, whose Download and Overwrite keep its edits. The etag is compared before the
    // quota and again by the write, under the file's lock, where two saves can't both pass. The write access
    // is checked first too, so a reader gets a 403 and a stale save a conflict even on a full mount.
    const etag = computeEtag(path);
    if (!save.force && save.expectedEtag !== etag) return { conflict: true, currentEtag: etag };
    await enforceMountQuota(ownerId, mountId, data.length, path.size);
    try {
        const ifMatch = save.force ? undefined : save.expectedEtag;
        const written = await drive.writeFileContent(mountId, pathId, data, { user, ifMatch, event: 'edited' });
        return { conflict: false, etag: written.etag };
    } catch (e) {
        if (e instanceof StaleWriteError) return { conflict: true, currentEtag: e.currentEtag };
        throw e;
    }
}
