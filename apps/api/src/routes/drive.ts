import {Elysia, t} from "elysia";
import {betterAuth} from "./auth";
import {getSharedDrive} from "../lib/drive/sharedDrive";

export const driveRouter = new Elysia({name: "drive"})
    .use(betterAuth)
    // Root and sharing routes
    .get("/drive/:ownerId/root", async ({params, user}) => {
        const drive = await getSharedDrive(params.ownerId, user);
        return await drive.getRootFolder();
    }, {auth: true})
    .get("/drive/:ownerId/shared/by-me", async ({params, user}) => {
        const drive = await getSharedDrive(params.ownerId, user);
        return await drive.getSharedPathsByMe();
    }, {auth: true})
    .get("/drive/:ownerId/shared/with-me", async ({params, user}) => {
        const drive = await getSharedDrive(params.ownerId, user);
        return await drive.getSharedPathsWithMe();
    }, {auth: true})
    // Folder operations
    .get("/drive/:ownerId/folder/:pathId", async ({params, user}) => {
        const drive = await getSharedDrive(params.ownerId, user);
        return await drive.getFolderContents(params.pathId);
    }, {auth: true})
    .post("/drive/:ownerId/folder/:pathId", async ({params, body, user}) => {
        const drive = await getSharedDrive(params.ownerId, user);
        return await drive.createFolder(params.pathId, body.folderName);
    }, {
        body: t.Object({folderName: t.String()}),
        auth: true
    })
    .delete("/drive/:ownerId/folder/:pathId", async ({params, user}) => {
        const drive = await getSharedDrive(params.ownerId, user);
        await drive.deleteFolder(params.pathId);
        return {success: true};
    }, {auth: true})
    .post("/drive/:ownerId/folder/:pathId/doc", async ({params, body, user}) => {
        const drive = await getSharedDrive(params.ownerId, user);
        return await drive.createDoc(params.pathId, body.fileName);
    }, {
        body: t.Object({fileName: t.String()}),
        auth: true
    })
    .post("/drive/:ownerId/folder/:pathId/stickies", async ({params, body, user}) => {
        const drive = await getSharedDrive(params.ownerId, user);
        return await drive.createStickies(params.pathId, body.fileName);
    }, {
        body: t.Object({fileName: t.String()}),
        auth: true
    })
    // File operations
    .get("/drive/:ownerId/file/:pathId", async ({params, user}) => {
        const drive = await getSharedDrive(params.ownerId, user);
        return await drive.getPath(params.pathId);
    }, {auth: true})
    .post("/drive/:ownerId/file/:pathId", async ({params, body, user}) => {
        const drive = await getSharedDrive(params.ownerId, user);
        return await drive.uploadFile(params.pathId, body.file);
    }, {
        body: t.Object({file: t.File({maxSize: 35 * 1024 * 1024})}),
        auth: true
    })
    .post("/drive/:ownerId/files/:pathId", async ({params, body, user}) => {
        const drive = await getSharedDrive(params.ownerId, user);
        return await drive.uploadFiles(params.pathId, body.files);
    }, {
        body: t.Object({files: t.Files({maxSize: 10 * 1024 * 1024})}),
        auth: true
    })
    .delete("/drive/:ownerId/file/:pathId", async ({params, user}) => {
        const drive = await getSharedDrive(params.ownerId, user);
        await drive.deleteFile(params.pathId);
        return {success: true};
    }, {auth: true})
    .get("/drive/:ownerId/file/:pathId/download", async ({params, user, set}) => {
        const drive = await getSharedDrive(params.ownerId, user);
        const path = await drive.getPath(params.pathId);
        if (path && path.name) {
            set.headers['Content-Disposition'] = `attachment; filename="${path.name}"`;
            set.headers['Cache-Control'] = 'public, max-age=86400';
            set.headers['Expires'] = new Date(Date.now() + 86400000).toUTCString();
        }
        return await drive.downloadFile(params.pathId);
    }, {auth: true})
    .get("/drive/:ownerId/file/:pathId/embed/:fileName", async ({params, user, set}) => {
        const drive = await getSharedDrive(params.ownerId, user);
        set.headers['Cache-Control'] = 'public, max-age=86400';
        set.headers['Expires'] = new Date(Date.now() + 86400000).toUTCString();
        return await drive.downloadFile(params.pathId);
    }, {auth: true})
    // Path operations (rename, move, acl, breadcrumb)
    .get("/drive/:ownerId/path/:pathId", async ({params, user}) => {
        const drive = await getSharedDrive(params.ownerId, user);
        return await drive.getPath(params.pathId);
    }, {auth: true})
    .put("/drive/:ownerId/path/:pathId/rename", async ({params, body, user}) => {
        const drive = await getSharedDrive(params.ownerId, user);
        await drive.renamePath(params.pathId, body.newName);
        return {success: true};
    }, {
        body: t.Object({newName: t.String()}),
        auth: true
    })
    .put("/drive/:ownerId/path/:pathId/move", async ({params, body, user}) => {
        const drive = await getSharedDrive(params.ownerId, user);
        await drive.movePath(params.pathId, body.targetParentId);
        return {success: true};
    }, {
        body: t.Object({targetParentId: t.String()}),
        auth: true
    })
    .put("/drive/:ownerId/path/:pathId/acl", async ({params, body, user}) => {
        const drive = await getSharedDrive(params.ownerId, user);
        await drive.updateACL(params.pathId, body.acl);
        return {success: true};
    }, {
        body: t.Object({
            acl: t.Array(t.Object({
                email: t.String(),
                read: t.Boolean(),
                write: t.Boolean(),
                public: t.Boolean()
            }))
        }),
        auth: true
    })
    .get("/drive/:ownerId/path/:pathId/breadcrumb", async ({params, user}) => {
        const drive = await getSharedDrive(params.ownerId, user);
        return await drive.breadCrumb(params.pathId);
    }, {auth: true})
    .get("/drive/:ownerId/path/:pathId/permissions/read", async ({params, user}) => {
        const drive = await getSharedDrive(params.ownerId, user);
        return {canRead: await drive.canRead(params.pathId, user)};
    }, {auth: true})
    .get("/drive/:ownerId/path/:pathId/permissions/write", async ({params, user}) => {
        const drive = await getSharedDrive(params.ownerId, user);
        return {canWrite: await drive.canWrite(params.pathId, user)};
    }, {auth: true})
    // Mime type filter
    .get("/drive/:ownerId/mime/:mimeType", async ({params, user}) => {
        const drive = await getSharedDrive(params.ownerId, user);
        return await drive.getMimeTypeContents(params.mimeType.replace('-', '/'));
    }, {auth: true})
    // Thumbnail
    .get("/drive/:ownerId/thumb/:fileName", async ({params, user, set}) => {
        set.headers['Cache-Control'] = 'public, max-age=86400';
        set.headers['Expires'] = new Date(Date.now() + 86400000).toUTCString();
        set.headers['Content-Type'] = 'image/webp';
        const drive = await getSharedDrive(params.ownerId, user);
        return await drive.getThumbnail(params.fileName);
    }, {auth: true});