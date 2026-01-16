import {Elysia, t} from "elysia";
import {betterAuth} from "./auth";
import {getSharedDrive} from "../lib/drive/sharedDrive";
import {getDrive} from "../lib/drive/drive";

export const driveRouter = new Elysia({name: "drive"})
    .use(betterAuth)
    .get("/drive/root/:ownerId", async ({params, user}) => {
        const drive = await getSharedDrive(params.ownerId, user);
        return await drive.getRootFolder();
    }, {auth: true})
    .get("/drive/shared/by-me", async ({user}) => {
        const drive = await getDrive(user);
        return await drive.getSharedPathsByMe();
    }, {auth: true})
    .get("/drive/shared/with-me", async ({user}) => {
        const drive = await getDrive(user);
        return await drive.getSharedPathsWithMe();
    }, {auth: true})
    .get("/drive/folder/:ownerId/:pathId", async ({params, user}) => {
        const drive = await getSharedDrive(params.ownerId, user);
        return await drive.getFolderContents(params.pathId);
    }, {auth: true})
    .get("/drive/mime/:ownerId/:mimeType", async ({params, user}) => {
        const drive = await getSharedDrive(params.ownerId, user);
        return await drive.getMimeTypeContents(params.mimeType.replace('-', '/'));
    }, {auth: true})
    .get("/drive/path/:ownerId/:pathId", async ({params, user}) => {
        const drive = await getSharedDrive(params.ownerId, user);
        return await drive.getPath(params.pathId);
    }, {auth: true})
    .post("/drive/folder/:ownerId/:pathId", async ({params, body, user}) => {
        const drive = await getSharedDrive(params.ownerId, user);
        return await drive.createFolder(params.pathId, body.folderName);
    }, {
        body: t.Object({folderName: t.String()}),
        auth: true
    })
    .post("/drive/files/:ownerId/:pathId", async ({params, body, user}) => {
        const drive = await getSharedDrive(params.ownerId, user);
        return await drive.uploadFiles(params.pathId, body.files);
    }, {
        body: t.Object({files: t.Files({maxSize: 10 * 1024 * 1024})}),
        auth: true
    })
    .post("/drive/file/:ownerId/:pathId", async ({params, body, user}) => {
        const drive = await getSharedDrive(params.ownerId, user);
        return await drive.uploadFile(params.pathId, body.file);
    }, {
        body: t.Object({file: t.File({maxSize: 35 * 1024 * 1024})}),
        auth: true
    })
    .delete("/drive/folder/:ownerId/:pathId", async ({params, user}) => {
        const drive = await getSharedDrive(params.ownerId, user);
        await drive.deleteFolder(params.pathId);
        return {success: true};
    }, {auth: true})
    .delete("/drive/file/:ownerId/:pathId", async ({params, user}) => {
        const drive = await getSharedDrive(params.ownerId, user);
        await drive.deleteFile(params.pathId);
        return {success: true};
    }, {auth: true})
    .put("/drive/path/rename/:ownerId/:pathId", async ({params, body, user}) => {
        const drive = await getSharedDrive(params.ownerId, user);
        await drive.renamePath(params.pathId, body.newName);
        return {success: true};
    }, {
        body: t.Object({newName: t.String()}),
        auth: true
    })
    .put("/drive/path/move/:ownerId/:pathId", async ({params, body, user}) => {
        const drive = await getSharedDrive(params.ownerId, user);
        await drive.movePath(params.pathId, body.targetParentId);
        return {success: true};
    }, {
        body: t.Object({targetParentId: t.String()}),
        auth: true
    })
    .put("/drive/path/acl/:ownerId/:pathId", async ({params, body, user}) => {
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
    .get("/drive/permissions/read/:ownerId/:pathId", async ({params, user}) => {
        const drive = await getSharedDrive(params.ownerId, user);
        return {canRead: await drive.canRead(params.pathId, user)};
    }, {auth: true})
    .get("/drive/permissions/write/:ownerId/:pathId", async ({params, user}) => {
        const drive = await getSharedDrive(params.ownerId, user);
        return {canWrite: await drive.canWrite(params.pathId, user)};
    }, {auth: true})
    .get("/drive/thumb/:ownerId/:fileName", async ({params, user, set}) => {
        set.headers['Cache-Control'] = 'public, max-age=86400';
        set.headers['Expires'] = new Date(Date.now() + 86400000).toUTCString();
        set.headers['Content-Type'] = 'image/webp';
        const drive = await getSharedDrive(params.ownerId, user);
        return await drive.getThumbnail(params.fileName);
    }, {auth: true})
    .get("/drive/download/:ownerId/:pathId", async ({params, user, set}) => {
        const drive = await getSharedDrive(params.ownerId, user);
        const path = await drive.getPath(params.pathId);
        if (path && path.name) {
            set.headers['Content-Disposition'] = `attachment; filename="${path.name}"`;
            set.headers['Cache-Control'] = 'public, max-age=86400';
            set.headers['Expires'] = new Date(Date.now() + 86400000).toUTCString();
        }
        return await drive.downloadFile(params.pathId);
    }, {auth: true})
    .get("/drive/embed/:ownerId/:pathId/:fileName", async ({params, user, set}) => {
        const drive = await getSharedDrive(params.ownerId, user);
        set.headers['Cache-Control'] = 'public, max-age=86400';
        set.headers['Expires'] = new Date(Date.now() + 86400000).toUTCString();
        return await drive.downloadFile(params.pathId);
    }, {auth: true})
    .get("/drive/breadcrumb/:ownerId/:pathId", async ({params, user}) => {
        const drive = await getSharedDrive(params.ownerId, user);
        return await drive.breadCrumb(params.pathId);
    }, {auth: true})
    .post("/drive/doc/:ownerId/:pathId", async ({params, body, user}) => {
        const drive = await getSharedDrive(params.ownerId, user);
        return await drive.createDoc(params.pathId, body.fileName);
    }, {
        body: t.Object({fileName: t.String()}),
        auth: true
    })
    .post("/drive/stickies/:ownerId/:pathId", async ({params, body, user}) => {
        const drive = await getSharedDrive(params.ownerId, user);
        return await drive.createStickies(params.pathId, body.fileName);
    }, {
        body: t.Object({fileName: t.String()}),
        auth: true
    })