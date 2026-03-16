import {Elysia, t} from "elysia";
import {betterAuth} from "./auth";
import {getSharedDrive} from "../lib/drive";
import {ApiError} from "../lib/core/errors";
import {getTextPreviewMode} from '@workspace/lib/constants';

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;

function extractFrontmatter(content: string): {frontmatter: string | null; body: string} {
    const match = content.match(FRONTMATTER_RE);
    if (match) return {frontmatter: match[1], body: match[2]};
    return {frontmatter: null, body: content};
}

function reattachFrontmatter(body: string, frontmatter: string | null): string {
    if (!frontmatter) return body;
    return `---\n${frontmatter}\n---\n${body}`;
}

export const editorRouter = new Elysia({name: "editor"})
    .use(betterAuth)

    .get("/editor/:ownerId/:mountId/:pathId/content", async ({params, user}) => {
        const drive = await getSharedDrive(params.ownerId, user);
        const path = await drive.getPath(params.mountId, params.pathId);
        if (!path || path.type !== 'file') throw new ApiError(404, 'File not found');

        const editMode = getTextPreviewMode(path.mimeType, path.name);
        if (!editMode) throw new ApiError(400, 'File type not supported for inline editing');
        if (path.size > MAX_FILE_SIZE) throw new ApiError(413, 'File too large for inline editing');

        const data = await drive.downloadFile(params.mountId, params.pathId);
        if (!data) throw new ApiError(404, 'File content not found');

        let content: string;
        try {
            content = new TextDecoder('utf-8', {fatal: true}).decode(data);
        } catch {
            throw new ApiError(400, 'File contains invalid UTF-8 encoding');
        }

        if (editMode === 'markdown') {
            const {frontmatter, body} = extractFrontmatter(content);
            return {editMode, content: body, frontmatter, mimeType: path.mimeType, updatedAt: path.updatedAt};
        }

        return {editMode, content, frontmatter: null, mimeType: path.mimeType, updatedAt: path.updatedAt};
    }, {auth: true})

    .put("/editor/:ownerId/:mountId/:pathId/content", async ({params, body, user}) => {
        const drive = await getSharedDrive(params.ownerId, user);
        const path = await drive.getPath(params.mountId, params.pathId);
        if (!path || path.type !== 'file') throw new ApiError(404, 'File not found');

        const currentUpdatedAt = path.updatedAt instanceof Date
            ? path.updatedAt.toISOString()
            : String(path.updatedAt);

        if (body.expectedUpdatedAt !== currentUpdatedAt && !body.force) {
            return {conflict: true as const, currentUpdatedAt};
        }

        const fullContent = reattachFrontmatter(body.content, body.frontmatter ?? null);
        const updated = await drive.writeFileContent(
            params.mountId, params.pathId, Buffer.from(fullContent, 'utf-8')
        );

        return {
            conflict: false as const,
            updatedAt: updated.updatedAt instanceof Date
                ? updated.updatedAt.toISOString()
                : String(updated.updatedAt)
        };
    }, {
        body: t.Object({
            content: t.String(),
            frontmatter: t.Optional(t.String()),
            expectedUpdatedAt: t.String(),
            force: t.Optional(t.Boolean()),
        }),
        auth: true
    });
