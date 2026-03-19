import {Elysia, t} from "elysia";
import {betterAuth} from "./auth";
import {getSharedDrive} from "../lib/drive";
import {getHome} from "../lib/home";
import {enforceBatchUpload, enforceFileUpload} from "../lib/config/enforcement";

// Drive routes allow cross-owner access (shared drives, team drives).
// Access control is enforced by getSharedDrive() → SharedDrive ACL checks, not by ownerId === user.id.
export const driveRouter = new Elysia({name: "drive"})
    .use(betterAuth)
    // Mount management
    .get("/drive/:ownerId/mounts", async ({params, user}) => {
        const drive = await getSharedDrive(params.ownerId, user);
        return await drive.listMounts();
    }, {auth: true})
    // Root and sharing routes
    .get("/drive/:ownerId/:mountId/root", async ({params, user}) => {
        const drive = await getSharedDrive(params.ownerId, user);
        return await drive.getRootFolder(params.mountId);
    }, {auth: true})
    .get("/drive/:ownerId/shared/by-me", async ({params, user}) => {
        const drive = await getSharedDrive(params.ownerId, user);
        return await drive.getSharedPathsByMe();
    }, {auth: true})
    .get("/drive/:ownerId/shared/with-me", async ({params, user}) => {
        const drive = await getSharedDrive(params.ownerId, user);
        return await drive.getSharedPathsWithMe();
    }, {auth: true})
    .get("/drive/:ownerId/shared-with-me", async ({params, user}) => {
        const ownerHome = await getHome(params.ownerId);
        return await ownerHome.drive.getSharedWith(user);
    }, {auth: true})
    // Folder operations
    .get("/drive/:ownerId/:mountId/folder/:pathId", async ({params, user}) => {
        const drive = await getSharedDrive(params.ownerId, user);
        return await drive.getFolderContents(params.mountId, params.pathId);
    }, {auth: true})
    .post("/drive/:ownerId/:mountId/folder/:pathId", async ({params, body, user}) => {
        const drive = await getSharedDrive(params.ownerId, user);
        return await drive.createFolder(params.mountId, params.pathId, body.folderName);
    }, {
        body: t.Object({folderName: t.String()}),
        auth: true
    })
    .delete("/drive/:ownerId/:mountId/folder/:pathId", async ({params, user}) => {
        const drive = await getSharedDrive(params.ownerId, user);
        await drive.deleteFolder(params.mountId, params.pathId);
        return {success: true};
    }, {auth: true})
    .post("/drive/:ownerId/:mountId/folder/:pathId/doc", async ({params, body, user}) => {
        const drive = await getSharedDrive(params.ownerId, user);
        return await drive.createDoc(params.mountId, params.pathId, body.fileName);
    }, {
        body: t.Object({fileName: t.String()}),
        auth: true
    })
    .post("/drive/:ownerId/:mountId/folder/:pathId/stickies", async ({params, body, user}) => {
        const drive = await getSharedDrive(params.ownerId, user);
        return await drive.createStickies(params.mountId, params.pathId, body.fileName);
    }, {
        body: t.Object({fileName: t.String()}),
        auth: true
    })
    .post("/drive/:ownerId/:mountId/folder/:pathId/slides", async ({params, body, user}) => {
        const drive = await getSharedDrive(params.ownerId, user);
        return await drive.createSlides(params.mountId, params.pathId, body.fileName);
    }, {
        body: t.Object({fileName: t.String()}),
        auth: true
    })
    .post("/drive/:ownerId/:mountId/folder/:pathId/sheets", async ({params, body, user}) => {
        const drive = await getSharedDrive(params.ownerId, user);
        return await drive.createSheets(params.mountId, params.pathId, body.fileName);
    }, {
        body: t.Object({fileName: t.String()}),
        auth: true
    })
    .post("/drive/:ownerId/:mountId/folder/:pathId/chat", async ({params, body, user}) => {
        const drive = await getSharedDrive(params.ownerId, user);
        return await drive.createChat(params.mountId, params.pathId, body.fileName);
    }, {
        body: t.Object({fileName: t.String()}),
        auth: true
    })
    // File operations
    .get("/drive/:ownerId/:mountId/file/:pathId", async ({params, user}) => {
        const drive = await getSharedDrive(params.ownerId, user);
        return await drive.getPath(params.mountId, params.pathId);
    }, {auth: true})
    .post("/drive/:ownerId/:mountId/file/:pathId", async ({params, body, user}) => {
        await enforceFileUpload(params.ownerId, user.id, params.mountId, body.file.size);
        const drive = await getSharedDrive(params.ownerId, user);
        return await drive.uploadFile(params.mountId, params.pathId, body.file);
    }, {
        body: t.Object({file: t.File()}),
        auth: true
    })
    .post("/drive/:ownerId/:mountId/files/:pathId", async ({params, body, user}) => {
        await enforceBatchUpload(params.ownerId, user.id, params.mountId, body.files);
        const drive = await getSharedDrive(params.ownerId, user);
        return await drive.uploadFiles(params.mountId, params.pathId, body.files);
    }, {
        body: t.Object({files: t.Files()}),
        auth: true
    })
    .delete("/drive/:ownerId/:mountId/file/:pathId", async ({params, user}) => {
        const drive = await getSharedDrive(params.ownerId, user);
        await drive.deleteFile(params.mountId, params.pathId);
        return {success: true};
    }, {auth: true})
    .get("/drive/:ownerId/:mountId/file/:pathId/download", async ({params, user, set}) => {
        const drive = await getSharedDrive(params.ownerId, user);
        const path = await drive.getPath(params.mountId, params.pathId);
        if (path && path.name) {
            const displayName = (path.details?.originalName || path.name).replace(/[\x00-\x1f"\\]/g, '_');
            set.headers['Content-Disposition'] = `attachment; filename="${displayName}"`;
            set.headers['Cache-Control'] = 'public, max-age=86400';
            set.headers['Expires'] = new Date(Date.now() + 86400000).toUTCString();
        }
        return await drive.downloadFile(params.mountId, params.pathId);
    }, {auth: true})
    .get("/drive/:ownerId/:mountId/file/:pathId/embed/:fileName", async ({params, user, set}) => {
        const drive = await getSharedDrive(params.ownerId, user);
        set.headers['Cache-Control'] = 'public, max-age=86400';
        set.headers['Expires'] = new Date(Date.now() + 86400000).toUTCString();
        return await drive.downloadFile(params.mountId, params.pathId);
    }, {auth: true})
    .get("/drive/:ownerId/:mountId/file/:pathId/preview", async ({params, user, set}) => {
        const drive = await getSharedDrive(params.ownerId, user);
        const embedUrl = `/drive/${params.ownerId}/${params.mountId}/file/${params.pathId}/embed/preview`;
        const result = await drive.getPreview(params.mountId, params.pathId, embedUrl);
        if (!result) {
            set.status = 404;
            return 'No preview available';
        }
        if (result.type === 'redirect') {
            set.redirect = result.url;
            return;
        }
        set.headers['Cache-Control'] = 'public, max-age=86400';
        set.headers['Expires'] = new Date(Date.now() + 86400000).toUTCString();
        set.headers['Content-Type'] = result.contentType;
        return result.data;
    }, {auth: true})
    .get("/drive/:ownerId/:mountId/file/:pathId/text-preview", async ({params, user, set}) => {
        const drive = await getSharedDrive(params.ownerId, user);
        const result = await drive.getTextPreview(params.mountId, params.pathId);
        if (!result) {
            set.status = 404;
            return {body: '', mode: 'plaintext'};
        }
        return result;
    }, {auth: true})
    // Path operations (rename, move, acl, breadcrumb)
    .get("/drive/:ownerId/:mountId/path/:pathId", async ({params, user}) => {
        const drive = await getSharedDrive(params.ownerId, user);
        return await drive.getPath(params.mountId, params.pathId);
    }, {auth: true})
    .put("/drive/:ownerId/:mountId/path/:pathId/rename", async ({params, body, user}) => {
        const drive = await getSharedDrive(params.ownerId, user);
        await drive.renamePath(params.mountId, params.pathId, body.newName);
        return {success: true};
    }, {
        body: t.Object({newName: t.String()}),
        auth: true
    })
    .put("/drive/:ownerId/:mountId/path/:pathId/move", async ({params, body, user}) => {
        const drive = await getSharedDrive(params.ownerId, user);
        return await drive.movePath(params.mountId, params.pathId, body.targetParentId);
    }, {
        body: t.Object({targetParentId: t.String()}),
        auth: true
    })
    .put("/drive/:ownerId/:mountId/path/:pathId/acl", async ({params, body, user}) => {
        const drive = await getSharedDrive(params.ownerId, user);
        await drive.updateACL(params.mountId, params.pathId, body.acl, body.visibility);
        return {success: true};
    }, {
        body: t.Object({
            acl: t.Array(t.Object({
                id: t.String(),
                read: t.Boolean(),
                write: t.Boolean(),
            })),
            visibility: t.Optional(t.Union([
                t.Literal('private'),
                t.Literal('public-read'),
                t.Literal('public-write'),
            ]))
        }),
        auth: true
    })
    .get("/drive/:ownerId/:mountId/path/:pathId/breadcrumb", async ({params, user}) => {
        const drive = await getSharedDrive(params.ownerId, user);
        return await drive.breadCrumb(params.mountId, params.pathId);
    }, {auth: true})
    .get("/drive/:ownerId/:mountId/path/:pathId/permissions/read", async ({params, user}) => {
        const drive = await getSharedDrive(params.ownerId, user);
        return {canRead: await drive.canRead(params.mountId, params.pathId, user)};
    }, {auth: true})
    .get("/drive/:ownerId/:mountId/path/:pathId/permissions/write", async ({params, user}) => {
        const drive = await getSharedDrive(params.ownerId, user);
        return {canWrite: await drive.canWrite(params.mountId, params.pathId, user)};
    }, {auth: true})
    // Mime type filter (aggregates over all mounts)
    .get("/drive/:ownerId/mime/:mimeType", async ({params, user}) => {
        const drive = await getSharedDrive(params.ownerId, user);
        return await drive.getMimeTypeContents(params.mimeType.replace('-', '/'), {excludeDocumentChildren: true});
    }, {auth: true})
    // Thumbnail
    .get("/drive/:ownerId/:mountId/thumb/:fileName", async ({params, user, set}) => {
        set.headers['Cache-Control'] = 'public, max-age=86400';
        set.headers['Expires'] = new Date(Date.now() + 86400000).toUTCString();
        set.headers['Content-Type'] = 'image/webp';
        const drive = await getSharedDrive(params.ownerId, user);
        return await drive.getThumbnail(params.mountId, params.fileName);
    }, {auth: true});
