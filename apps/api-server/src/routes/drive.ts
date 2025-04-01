import {Elysia, t} from "elysia";
import {betterAuth} from "./auth";
import {getDrive} from "../lib/drive/drive";
import {type User} from "better-auth/types";
import {type DriveACL} from "../types/drive";

// Define types for request bodies
type CreateFolderBody = {
    parentId: string;
    folderName: string;
}

type UploadFileBody = {
    file: File;
}

type RenamePathBody = {
    pathId: string;
    newName: string;
}

type UpdateACLBody = {
    pathId: string;
    acl: DriveACL[];
}

export const driveRouter = new Elysia({name: "drive"})
    .use(betterAuth)

    // Get root folder
    .get("/drive/root", async ({user}: { user: User }) => {
        const drive = await getDrive(user);
        return await drive.getRootFolder();
    }, {
        auth: true
    })

    // Get folder contents
    .get("/drive/folder/:pathId", async ({params, user}: { params: { pathId: string }, user: User }) => {
        const drive = await getDrive(user);
        return await drive.getFolderContents(params.pathId);
    }, {
        auth: true,
        params: t.Object({
            pathId: t.String()
        })
    })
    
    // Get path info
    .get("/drive/path/:pathId", async ({params, user}: { params: { pathId: string }, user: User }) => {
        const drive = await getDrive(user);
        return await drive.getPath(params.pathId);
    }, {
        auth: true,
        params: t.Object({
            pathId: t.String()
        })
    })
    
    // Create folder
    .post("/drive/folder", async ({body, user}: { body: CreateFolderBody, user: User }) => {
        const drive = await getDrive(user);
        return await drive.createFolder(body.parentId, body.folderName);
    }, {
        auth: true,
        body: t.Object({
            parentId: t.String(),
            folderName: t.String()
        })
    })
    
    // Upload file
    .post("/drive/file/:pathId", async ({params, body, user}: { params: { pathId: string }, body: UploadFileBody, user: User }) => {
        const drive = await getDrive(user);
        return await drive.uploadFile(params.pathId, body.file);
    }, {
        auth: true,
        body: t.Object({
            file: t.File({
                maxSize: 5 * 1024 * 1024  // 5MB maximum file size
            })
        })
    })
    
    // Delete folder
    .delete("/drive/folder/:pathId", async ({params, user}: { params: { pathId: string }, user: User }) => {
        const drive = await getDrive(user);
        await drive.deleteFolder(params.pathId);
        return { success: true };
    }, {
        auth: true,
        params: t.Object({
            pathId: t.String()
        })
    })
    
    // Delete file
    .delete("/drive/file/:pathId", async ({params, user}: { params: { pathId: string }, user: User }) => {
        const drive = await getDrive(user);
        await drive.deleteFile(params.pathId);
        return { success: true };
    }, {
        auth: true,
        params: t.Object({
            pathId: t.String()
        })
    })
    
    // Rename path (file or folder)
    .put("/drive/path/rename", async ({body, user}: { body: RenamePathBody, user: User }) => {
        const drive = await getDrive(user);
        await drive.renamePath(body.pathId, body.newName);
        return { success: true };
    }, {
        auth: true,
        body: t.Object({
            pathId: t.String(),
            newName: t.String()
        })
    })
    
    // Update ACL
    .put("/drive/path/acl", async ({body, user}: { body: UpdateACLBody, user: User }) => {
        const drive = await getDrive(user);
        await drive.updateACL(body.pathId, body.acl);
        return { success: true };
    }, {
        auth: true,
        body: t.Object({
            pathId: t.String(),
            acl: t.Array(
                t.Object({
                    userId: t.String(),
                    read: t.Boolean(),
                    write: t.Boolean(),
                    public: t.Boolean()
                })
            )
        })
    })
    
    // Check read permission
    .get("/drive/permissions/read/:pathId", async ({params, user}: { params: { pathId: string }, user: User }) => {
        const drive = await getDrive(user);
        return { canRead: await drive.canRead(params.pathId, user) };
    }, {
        auth: true,
        params: t.Object({
            pathId: t.String()
        })
    })
    
    // Check write permission
    .get("/drive/permissions/write/:pathId", async ({params, user}: { params: { pathId: string }, user: User }) => {
        const drive = await getDrive(user);
        return { canWrite: await drive.canWrite(params.pathId, user) };
    }, {
        auth: true,
        params: t.Object({
            pathId: t.String()
        })
    });
