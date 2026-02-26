import {useMutation, useQuery, useQueryClient, type QueryClient} from "@tanstack/react-query";
import type {DriveACL, DrivePath, DriveVisibility} from "@workspace/lib/types/drive";
import {driveApi} from "@workspace/lib/api";
import {invalidateHomeSize} from '../../home';
import {DEFAULT_MOUNT_ID} from "@workspace/lib/types/mount";

export {DEFAULT_MOUNT_ID};

// Define query keys for reuse
export const driveKeys = {
    all: ['drive'] as const,
    mounts: () => [...driveKeys.all, 'mounts'] as const,
    root: (ownerId: string, mountId: string) => [...driveKeys.all, 'root', ownerId, mountId] as const,
    folders: () => [...driveKeys.all, 'folder'] as const,
    folder: (mountId: string, pathId: string) => [...driveKeys.folders(), mountId, pathId] as const,
    mimeTypes: () => [...driveKeys.all, 'mime'] as const,
    mime: (mimeType: string) => [...driveKeys.mimeTypes(), mimeType] as const,
    paths: () => [...driveKeys.all, 'path'] as const,
    path: (mountId: string, pathId: string) => [...driveKeys.paths(), mountId, pathId] as const,
    permissions: () => [...driveKeys.all, 'permissions'] as const,
    read: (mountId: string, pathId: string) => [...driveKeys.permissions(), 'read', mountId, pathId] as const,
    write: (mountId: string, pathId: string) => [...driveKeys.permissions(), 'write', mountId, pathId] as const,
    shared: (to: 'by-me' | 'with-me') => [...driveKeys.all, 'shared', to] as const,
};

// GET MOUNTS
export function useMounts(ownerId: string) {
    return useQuery({
        queryKey: driveKeys.mounts(),
        queryFn: async () => {
            const response = await driveApi({ownerId}).mounts.get();
            return response.data || [];
        },
        staleTime: Infinity,
        enabled: !!ownerId,
    });
}

// GET ROOT FOLDER
export function useRootFolder(ownerId: string, mountId: string = DEFAULT_MOUNT_ID) {
    return useQuery({
        queryKey: driveKeys.root(ownerId, mountId),
        queryFn: async () => {
            const response = await driveApi({ownerId})({mountId}).root.get();
            return response.data || null;
        },
        staleTime: Infinity,
        enabled: !!ownerId && !!mountId,
    });
}

// GET FOLDER CONTENTS
export function useFolderContent(ownerId: string, mountId: string, pathId: string) {
    return useQuery({
        queryKey: driveKeys.folder(mountId, pathId),
        queryFn: async () => {
            if (!pathId) return [];
            const response = await driveApi({ownerId})({mountId}).folder({pathId}).get();
            if (response.error) {
                throw new Error(String(response.error));
            }
            return response.data || [];
        },
        enabled: !!pathId && !!ownerId && !!mountId,
        retry: 1,
        staleTime: 1000 * 60 * 5 // 5 minutes
    });
}

// GET MIME CONTENTS (aggregates over all mounts)
export function useMimeContent(ownerId: string, mimeType: string) {
    return useQuery({
        queryKey: driveKeys.mime(mimeType),
        queryFn: async () => {
            if (!mimeType) return [];
            const response = await driveApi({ownerId}).mime({mimeType}).get();
            if (response.error) {
                throw new Error(String(response.error));
            }
            return response.data || [];
        },
        enabled: !!mimeType && !!ownerId,
        retry: 1,
        staleTime: 1000 * 60 * 5 // 5 minutes
    });
}

// GET PATH INFO
export function usePathInfo(ownerId: string, mountId: string, pathId: string | undefined) {
    return useQuery({
        queryKey: driveKeys.path(mountId, pathId || ''),
        queryFn: async () => {
            if (!pathId) return null;
            const response = await driveApi({ownerId})({mountId}).path({pathId}).get();
            return response.data || null;
        },
        enabled: !!pathId && !!ownerId && !!mountId,
        staleTime: 1000 * 60 * 5 // 5 minutes
    });
}

// CREATE FOLDER
export function useCreateFolder(ownerId: string, mountId: string = DEFAULT_MOUNT_ID) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({parentId, folderName}: { parentId: string, folderName: string }) => {
            const response = await driveApi({ownerId})({mountId}).folder({pathId: parentId}).post({folderName});
            return response.data;
        },
        onSuccess: (_data, variables) => invalidateItemCreated(queryClient, mountId, variables.parentId),
    });
}

// UPLOAD FILE
export function useUploadFile(ownerId: string, mountId: string = DEFAULT_MOUNT_ID) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({parentId, file}: { parentId: string, file: File }) => {
            const response = await driveApi({ownerId})({mountId}).file({pathId: parentId}).post({file});
            return response.data;
        },
        onSuccess: (_data, variables) => invalidateItemCreated(queryClient, mountId, variables.parentId),
    });
}

// UPLOAD FILES
export function useUploadFiles(ownerId: string, mountId: string = DEFAULT_MOUNT_ID) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({parentId, files}: { parentId: string, files: File[] }) => {
            const response = await driveApi({ownerId})({mountId}).files({pathId: parentId}).post({files});
            return response.data;
        },
        onSuccess: (_data, variables) => invalidateItemCreated(queryClient, mountId, variables.parentId),
    });
}

// DELETE FOLDER
export function useDeleteFolder(ownerId: string, mountId: string = DEFAULT_MOUNT_ID, parentId?: string, mimeType?: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (pathId: string) => {
            const response = await driveApi({ownerId})({mountId}).folder({pathId}).delete();
            return response.data;
        },
        onSuccess: (_data, pathId) => invalidateItemDeleted(queryClient, mountId, pathId, parentId, mimeType),
    });
}

// DELETE FILE
export function useDeleteFile(ownerId: string, mountId: string = DEFAULT_MOUNT_ID, parentId?: string, mimeType?: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (pathId: string) => {
            const response = await driveApi({ownerId})({mountId}).file({pathId}).delete();
            return response.data;
        },
        onSuccess: (_data, pathId) => invalidateItemDeleted(queryClient, mountId, pathId, parentId, mimeType),
    });
}

export function useMovePath(ownerId: string, mountId: string = DEFAULT_MOUNT_ID, currentParentId?: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({pathId, targetParentId}: { pathId: string, targetParentId: string }) => {
            const response = await driveApi({ownerId})({mountId}).path({pathId}).move.put({targetParentId});
            return response.data;
        },
        onSuccess: (_data, variables) => invalidatePathMoved(queryClient, mountId, variables.pathId, variables.targetParentId, currentParentId),
    });
}

export function useRenamePath(ownerId: string, mountId: string = DEFAULT_MOUNT_ID, parentId?: string, mimeType?: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({pathId, newName}: { pathId: string, newName: string }) => {
            const response = await driveApi({ownerId})({mountId}).path({pathId}).rename.put({newName});
            return response.data;
        },
        onSuccess: (_data, variables) => invalidatePathRenamed(queryClient, mountId, variables.pathId, parentId, mimeType),
    });
}

// UPDATE ACL
export function useUpdateACL(ownerId: string, mountId: string = DEFAULT_MOUNT_ID) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({path, acl, visibility}: { path: DrivePath, acl: DriveACL[], visibility?: DriveVisibility }) => {
            const response = await driveApi({ownerId})({mountId}).path({pathId: path.id}).acl.put({acl, visibility});
            return response.data;
        },
        onSuccess: (_data, variables) => invalidateAclUpdated(queryClient, variables.path.mountId, variables.path.id, variables.path.parentId),
    });
}

// CHECK READ PERMISSION
export function useCheckReadPermission(ownerId: string, mountId: string, pathId: string | undefined) {
    return useQuery({
        queryKey: driveKeys.read(mountId, pathId || ''),
        queryFn: async () => {
            if (!pathId) return {canRead: false};
            const response = await driveApi({ownerId})({mountId}).path({pathId}).permissions.read.get();
            return response.data || {canRead: false};
        },
        enabled: !!pathId && !!ownerId && !!mountId,
    });
}

// CHECK WRITE PERMISSION
export function useCheckWritePermission(ownerId: string, mountId: string, pathId: string | undefined) {
    return useQuery({
        queryKey: driveKeys.write(mountId, pathId || ''),
        queryFn: async () => {
            if (!pathId) return {canWrite: false};
            const response = await driveApi({ownerId})({mountId}).path({pathId}).permissions.write.get();
            return response.data || {canWrite: false};
        },
        enabled: !!pathId && !!ownerId && !!mountId,
    });
}

// GET BREADCRUMB PATH
export function useBreadcrumb(ownerId: string, mountId: string, pathId: string | undefined) {
    return useQuery({
        queryKey: [...driveKeys.path(mountId, pathId || ''), 'breadcrumb'],
        queryFn: async () => {
            if (!pathId) return [];
            const response = await driveApi({ownerId})({mountId}).path({pathId}).breadcrumb.get();
            return response.data || [];
        },
        enabled: !!pathId && !!ownerId && !!mountId,
    });
}

// CREATE DOC
export function useCreateDoc(ownerId: string, mountId: string = DEFAULT_MOUNT_ID) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({parentId, fileName}: { parentId: string, fileName: string }) => {
            const response = await driveApi({ownerId})({mountId}).folder({pathId: parentId}).doc.post({fileName});
            return response.data;
        },
        onSuccess: (_data, variables) => invalidateItemCreated(queryClient, mountId, variables.parentId, 'application/eigendoc'),
    });
}

// CREATE STICKIES
export function useCreateStickies(ownerId: string, mountId: string = DEFAULT_MOUNT_ID) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({parentId, fileName}: { parentId: string, fileName: string }) => {
            const response = await driveApi({ownerId})({mountId}).folder({pathId: parentId}).stickies.post({fileName});
            return response.data;
        },
        onSuccess: (_data, variables) => invalidateItemCreated(queryClient, mountId, variables.parentId, 'application/eigenstickies'),
    });
}

export function useSharedPaths(ownerId: string, to: 'by-me' | 'with-me') {
    return useQuery({
        queryKey: driveKeys.shared(to),
        queryFn: async () => {
            if (to === 'by-me') {
                const response = await driveApi({ownerId}).shared['by-me'].get();
                return response.data;
            } else {
                const response = await driveApi({ownerId}).shared['with-me'].get();
                return response.data;
            }
        },
        enabled: !!ownerId,
    });
}

// SSE invalidation functions
export function invalidateAclSharedOrUnshared(queryClient: QueryClient): void {
    queryClient.invalidateQueries({queryKey: driveKeys.shared('with-me')});
}

export function invalidateItemCreated(queryClient: QueryClient, mountId: string, parentId: string | null | undefined, mimeType?: string | null): void {
    if (parentId) {
        queryClient.invalidateQueries({queryKey: driveKeys.folder(mountId, parentId)});
    }
    if (mimeType) {
        const normalizedMimeType = mimeType.replace('/', '-');
        queryClient.invalidateQueries({queryKey: driveKeys.mime(normalizedMimeType)});
    }
    invalidateHomeSize(queryClient);
}

export function invalidateItemDeleted(queryClient: QueryClient, mountId: string, pathId: string, parentId: string | null | undefined, mimeType: string | null | undefined): void {
    if (parentId) {
        queryClient.invalidateQueries({queryKey: driveKeys.folder(mountId, parentId)});
    }
    queryClient.removeQueries({queryKey: driveKeys.path(mountId, pathId)});
    if (mimeType) {
        const normalizedMimeType = mimeType.replace('/', '-');
        queryClient.invalidateQueries({queryKey: driveKeys.mime(normalizedMimeType)});
    }
    invalidateHomeSize(queryClient);
}

export function invalidatePathRenamed(queryClient: QueryClient, mountId: string, pathId: string, parentId: string | null | undefined, mimeType: string | null | undefined): void {
    queryClient.invalidateQueries({queryKey: driveKeys.path(mountId, pathId)});
    if (parentId) {
        queryClient.invalidateQueries({queryKey: driveKeys.folder(mountId, parentId)});
    }
    if (mimeType) {
        const normalizedMimeType = mimeType.replace('/', '-');
        queryClient.invalidateQueries({queryKey: driveKeys.mime(normalizedMimeType)});
    }
}

export function invalidatePathMoved(queryClient: QueryClient, mountId: string, pathId: string, parentId: string | null | undefined, oldParentId: string | null | undefined): void {
    queryClient.invalidateQueries({queryKey: driveKeys.path(mountId, pathId)});
    if (parentId) {
        queryClient.invalidateQueries({queryKey: driveKeys.folder(mountId, parentId)});
    }
    if (oldParentId) {
        queryClient.invalidateQueries({queryKey: driveKeys.folder(mountId, oldParentId)});
    }
}

export function invalidateAclUpdated(queryClient: QueryClient, mountId: string, pathId: string, parentId: string | null | undefined): void {
    queryClient.invalidateQueries({queryKey: driveKeys.shared('by-me')});
    queryClient.invalidateQueries({queryKey: driveKeys.shared('with-me')});
    queryClient.invalidateQueries({queryKey: driveKeys.path(mountId, pathId)});
    if (parentId) {
        queryClient.invalidateQueries({queryKey: driveKeys.folder(mountId, parentId)});
    }
}

