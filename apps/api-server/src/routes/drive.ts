import {Elysia, t} from "elysia";
import {betterAuth} from "./auth";
import {type User} from "better-auth/types";
import {type DriveACL} from "../types/drive";
import {getSharedDrive} from "../lib/drive/sharedDrive";
import {getDrive} from "../lib/drive/drive";

// Define types for request bodies
type CreateFolderBody = {
    parentId: string;
    folderName: string;
}

type CreateDocBody = {
    parentId: string;
    fileName: string;
}

type CreateStickiesBody = {
    parentId: string;
    fileName: string;
}

type UploadFilesBody = {
    files: File[];
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
    .get("/drive/root/:ownerId", async ({params, user}: { params: { ownerId: string }, user: User }) => {
        const drive = await getSharedDrive(params.ownerId, user);
        return await drive.getRootFolder();
    }, {
        auth: true,
        params: t.Object({
            ownerId: t.String()
        })
    })

    .get("/drive/shared/by-me", async ({user}: { user: User }) => {
        const drive = await getDrive(user);
        return await drive.getSharedPathsByMe();
    }, {
        auth: true
    })

    .get("/drive/shared/with-me", async ({user}: { user: User }) => {
        const drive = await getDrive(user);
        return await drive.getSharedPathsWithMe();
    }, {
        auth: true
    })

    // Get folder contents
    .get("/drive/folder/:ownerId/:pathId", async ({params, user}: {
        params: { ownerId: string, pathId: string },
        user: User
    }) => {
        const drive = await getSharedDrive(params.ownerId, user);
        return await drive.getFolderContents(params.pathId);
    }, {
        auth: true,
        params: t.Object({
            ownerId: t.String(),
            pathId: t.String()
        })
    })

    .get("/drive/mime/:ownerId/:mimeType", async ({params, user}: {
        params: { ownerId: string, mimeType: string },
        user: User
    }) => {
        const drive = await getSharedDrive(params.ownerId, user);
        return await drive.getMimeTypeContents(params.mimeType.replace('-', '/'));
    }, {
        auth: true,
        params: t.Object({
            ownerId: t.String(),
            mimeType: t.String()
        })
    })

    // Get path info
    .get("/drive/path/:ownerId/:pathId", async ({params, user}: {
        params: { ownerId: string, pathId: string },
        user: User
    }) => {
        const drive = await getSharedDrive(params.ownerId, user);
        return await drive.getPath(params.pathId);
    }, {
        auth: true,
        params: t.Object({
            ownerId: t.String(),
            pathId: t.String()
        })
    })

    // Create folder
    .post("/drive/folder/:ownerId/:pathId", async ({params, body, user}: {
        params: { ownerId: string, pathId: string },
        body: CreateFolderBody,
        user: User
    }) => {
        const drive = await getSharedDrive(params.ownerId, user);
        return await drive.createFolder(params.pathId, body.folderName);
    }, {
        auth: true,
        params: t.Object({
            ownerId: t.String(),
            pathId: t.String()
        }),
        body: t.Object({
            folderName: t.String()
        })
    })

    // Upload file
    .post("/drive/files/:ownerId/:pathId", async ({params, body, user}: {
        params: { ownerId: string, pathId: string },
        body: UploadFilesBody,
        user: User
    }) => {
        const drive = await getSharedDrive(params.ownerId, user);
        return await drive.uploadFiles(params.pathId, body.files);
    }, {
        auth: true,
        params: t.Object({
            ownerId: t.String(),
            pathId: t.String()
        }),
        body: t.Object({
            files: t.Array(t.File({
                maxSize: 10 * 1024 * 1024  // 5MB maximum file size
            }))
        })
    })

    .post("/drive/file/:ownerId/:pathId", async ({params, body, user}: {
        params: { ownerId: string, pathId: string },
        body: UploadFileBody,
        user: User
    }) => {
        const drive = await getSharedDrive(params.ownerId, user);
        return await drive.uploadFile(params.pathId, body.file);
    }, {
        auth: true,
        params: t.Object({
            ownerId: t.String(),
            pathId: t.String()
        }),
        body: t.Object({
            file: t.File({
                maxSize: 35 * 1024 * 1024  // 35MB maximum file size
            })
        })
    })

    // Delete folder
    .delete("/drive/folder/:ownerId/:pathId", async ({params, user}: {
        params: { ownerId: string, pathId: string },
        user: User
    }) => {
        const drive = await getSharedDrive(params.ownerId, user);
        await drive.deleteFolder(params.pathId);
        return {success: true};
    }, {
        auth: true,
        params: t.Object({
            ownerId: t.String(),
            pathId: t.String()
        })
    })

    // Delete file
    .delete("/drive/file/:ownerId/:pathId", async ({params, user}: {
        params: { ownerId: string, pathId: string },
        user: User
    }) => {
        const drive = await getSharedDrive(params.ownerId, user);
        await drive.deleteFile(params.pathId);
        return {success: true};
    }, {
        auth: true,
        params: t.Object({
            ownerId: t.String(),
            pathId: t.String()
        })
    })

    // Rename path (file or folder)
    .put("/drive/path/rename/:ownerId/:pathId", async ({params, body, user}: {
        params: { ownerId: string, pathId: string },
        body: RenamePathBody,
        user: User
    }) => {
        const drive = await getSharedDrive(params.ownerId, user);
        await drive.renamePath(params.pathId, body.newName);
        return {success: true};
    }, {
        auth: true,
        params: t.Object({
            ownerId: t.String(),
            pathId: t.String()
        }),
        body: t.Object({
            newName: t.String()
        })
    })

    // Update ACL
    .put("/drive/path/acl/:ownerId/:pathId", async ({params, body, user}: {
        params: { ownerId: string, pathId: string },
        body: UpdateACLBody,
        user: User
    }) => {
        const drive = await getSharedDrive(params.ownerId, user);
        await drive.updateACL(params.pathId, body.acl);
        return {success: true};
    }, {
        auth: true,
        params: t.Object({
            ownerId: t.String(),
            pathId: t.String()
        }),
        body: t.Object({
            acl: t.Array(
                t.Object({
                    email: t.String(),
                    read: t.Boolean(),
                    write: t.Boolean(),
                    public: t.Boolean()
                })
            )
        })
    })

    // Check read permission
    .get("/drive/permissions/read/:ownerId/:pathId", async ({params, user}: {
        params: { ownerId: string, pathId: string },
        user: User
    }) => {
        const drive = await getSharedDrive(params.ownerId, user);
        return {canRead: await drive.canRead(params.pathId, user)};
    }, {
        auth: true,
        params: t.Object({
            ownerId: t.String(),
            pathId: t.String()
        })
    })

    // Check write permission
    .get("/drive/permissions/write/:ownerId/:pathId", async ({params, user}: {
        params: { ownerId: string, pathId: string },
        user: User
    }) => {
        const drive = await getSharedDrive(params.ownerId, user);
        return {canWrite: await drive.canWrite(params.pathId, user)};
    }, {
        auth: true,
        params: t.Object({
            ownerId: t.String(),
            pathId: t.String()
        })
    })

    .get("/drive/thumb/:ownerId/:fileName", async ({params, user, set}: {
        params: { ownerId: string, fileName: string },
        user: User,
        set: any
    }) => {
        // Set caching headers for thumbnails (1 day)
        set.headers['Cache-Control'] = 'public, max-age=86400';
        set.headers['Expires'] = new Date(Date.now() + 86400000).toUTCString();
        set.headers['Content-Type'] = 'image/webp';

        const drive = await getSharedDrive(params.ownerId, user);
        return await drive.getThumbnail(params.fileName);
    }, {
        auth: true,
        params: t.Object({
            ownerId: t.String(),
            fileName: t.String()
        })
    })

    .get("/drive/download/:ownerId/:pathId", async ({params, user, set}: {
        params: { ownerId: string, pathId: string },
        user: User,
        set: any
    }) => {
        const drive = await getSharedDrive(params.ownerId, user);
        const path = await drive.getPath(params.pathId);

        if (path && path.name) {
            // Set the Content-Disposition header with the file's name
            set.headers['Content-Disposition'] = `attachment; filename="${path.name}"`;
        }

        return await drive.downloadFile(params.pathId);
    }, {
        auth: true,
        params: t.Object({
            ownerId: t.String(),
            pathId: t.String()
        })
    })

    .get("/drive/embed/:ownerId/:pathId/:fileName", async ({params, user}: {
        params: { ownerId: string, pathId: string, fileName: string },
        user: User
    }) => {
        const drive = await getSharedDrive(params.ownerId, user);
        return await drive.downloadFile(params.pathId);
    }, {
        auth: true,
        params: t.Object({
            ownerId: t.String(),
            pathId: t.String(),
            fileName: t.String()
        })
    })

    .get("/drive/breadcrumb/:ownerId/:pathId", async ({params, user}: {
        params: { ownerId: string, pathId: string },
        user: User
    }) => {
        const drive = await getSharedDrive(params.ownerId, user);
        return await drive.breadCrumb(params.pathId);
    }, {
        auth: true,
        params: t.Object({
            ownerId: t.String(),
            pathId: t.String()
        })
    })

    // Create doc
    .post("/drive/doc/:ownerId/:pathId", async ({params, body, user}: {
        params: { ownerId: string, pathId: string },
        body: CreateDocBody,
        user: User
    }) => {
        const drive = await getSharedDrive(params.ownerId, user);
        return await drive.createDoc(params.pathId, body.fileName);
    }, {
        auth: true,
        params: t.Object({
            ownerId: t.String(),
            pathId: t.String()
        }),
        body: t.Object({
            fileName: t.String()
        })
    })

    // Create stickies
    .post("/drive/stickies/:ownerId/:pathId", async ({params, body, user}: {
        params: { ownerId: string, pathId: string },
        body: CreateStickiesBody,
        user: User
    }) => {
        const drive = await getSharedDrive(params.ownerId, user);
        return await drive.createStickies(params.pathId, body.fileName);
    }, {
        auth: true,
        params: t.Object({
            ownerId: t.String(),
            pathId: t.String()
        }),
        body: t.Object({
            fileName: t.String()
        })
    })