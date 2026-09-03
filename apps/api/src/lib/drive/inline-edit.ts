import { getTextPreviewMode } from '@workspace/lib/constants';
import { DRIVE_TYPE_FILE } from '@workspace/lib/types';
import type { DrivePath, FileEditorContent } from '@workspace/lib/types/drive';
import { ApiError } from '../core';
import type { Mount } from '../mount';

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

    const editMode = getTextPreviewMode(path.mimeType, path.name);
    if (!editMode) throw new ApiError(400, 'File type not supported for inline editing');
    if (path.size > MAX_INLINE_EDIT_SIZE) throw new ApiError(413, 'File too large for inline editing');

    const file = await mount.readFile(path.id);
    if (!file) throw new ApiError(404, 'File content not found');

    let content: string;
    try {
        content = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
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
    return { editMode, content: body, frontmatter, mimeType: path.mimeType, updatedAt: path.updatedAt };
}

export function prepareSaveContent(
    path: DrivePath,
    content: string,
    frontmatter: string | null,
    expectedUpdatedAt: Date,
    force: boolean,
): { conflict: true; currentUpdatedAt: Date } | { conflict: false; data: Buffer } {
    if (path.type !== DRIVE_TYPE_FILE) throw new ApiError(404, 'File not found');

    if (path.updatedAt.getTime() !== expectedUpdatedAt.getTime() && !force) {
        return { conflict: true, currentUpdatedAt: path.updatedAt };
    }

    const data = Buffer.from(reattachFrontmatter(content, frontmatter), 'utf-8');
    // Same cap as the read side (getEditableContent) — a save past it would open a 413 next time.
    if (data.length > MAX_INLINE_EDIT_SIZE) throw new ApiError(413, 'File too large for inline editing');
    return { conflict: false, data };
}
