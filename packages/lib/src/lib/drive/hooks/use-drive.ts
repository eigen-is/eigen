import {useMutation, useQuery, useQueryClient, type QueryClient} from "@tanstack/react-query";
import type {DriveACL, DrivePath} from "@workspace/lib/types/drive";
import {driveApi} from "@workspace/lib/api";
import {invalidateHomeSize} from '../../home';

// Define query keys for reuse
export const driveKeys = {
    all: ['drive'] as const,
    root: () => [...driveKeys.all, 'root'] as const,
    folders: () => [...driveKeys.all, 'folder'] as const,
    folder: (pathId: string) => [...driveKeys.folders(), pathId] as const,
    mimeTypes: () => [...driveKeys.all, 'mime'] as const,
    mime: (mimeType: string) => [...driveKeys.mimeTypes(), mimeType] as const,
    paths: () => [...driveKeys.all, 'path'] as const,
    path: (pathId: string) => [...driveKeys.paths(), pathId] as const,
    permissions: () => [...driveKeys.all, 'permissions'] as const,
    read: (pathId: string) => [...driveKeys.permissions(), 'read', pathId] as const,
    write: (pathId: string) => [...driveKeys.permissions(), 'write', pathId] as const,
    shared: (to: 'by-me' | 'with-me') => [...driveKeys.all, 'shared', to] as const,
};

// GET ROOT FOLDER
export function useRootFolder(ownerId: string) {
    return useQuery({
        queryKey: driveKeys.root(),
        queryFn: async () => {
            const response = await driveApi.root({ownerId}).get();
            return response.data || null;
        },
        staleTime: Infinity
    });
}

// GET FOLDER CONTENTS
export function useFolderContent(ownerId: string, pathId: string) {
    return useQuery({
        queryKey: driveKeys.folder(pathId),
        queryFn: async () => {
            if (!pathId) return [];
            const response = await driveApi.folder({ownerId})({pathId}).get();
            if (response.error) {
                throw new Error(String(response.error));
            }
            return response.data || [];
        },
        enabled: !!pathId,
        retry: 1,
        staleTime: 1000 * 60 * 5 // 5 minutes
    });
}

// GET MIME CONTENTS
export function useMimeContent(ownerId: string, mimeType: string) {
    return useQuery({
        queryKey: driveKeys.mime(mimeType),
        queryFn: async () => {
            if (!mimeType) return [];
            const response = await driveApi.mime({ownerId})({mimeType}).get();
            if (response.error) {
                throw new Error(String(response.error));
            }
            return response.data || [];
        },
        enabled: !!mimeType,
        retry: 1,
        staleTime: 1000 * 60 * 5 // 5 minutes
    });
}

// GET PATH INFO
export function usePathInfo(ownerId: string, pathId: string | undefined) {
    return useQuery({
        queryKey: driveKeys.path(pathId || ''),
        queryFn: async () => {
            if (!pathId) return null;
            const response = await driveApi.path({ownerId})({pathId}).get();
            return response.data || null;
        },
        enabled: !!pathId,
        staleTime: 1000 * 60 * 5 // 5 minutes
    });
}

// CREATE FOLDER
export function useCreateFolder(ownerId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({parentId, folderName}: { parentId: string, folderName: string }) => {
            const response = await driveApi.folder({ownerId})({pathId: parentId}).post({folderName});
            return response.data;
        },
        onSuccess: (_data, variables) => invalidateItemCreated(queryClient, variables.parentId),
    });
}

// UPLOAD FILE
export function useUploadFile(ownerId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({parentId, file}: { parentId: string, file: File }) => {
            const response = await driveApi.file({ownerId})({pathId: parentId}).post({file});
            return response.data;
        },
        onSuccess: (_data, variables) => invalidateItemCreated(queryClient, variables.parentId),
    });
}


// UPLOAD FILES
export function useUploadFiles(ownerId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({parentId, files}: { parentId: string, files: File[] }) => {
            const response = await driveApi.files({ownerId})({pathId: parentId}).post({files});
            return response.data;
        },
        onSuccess: (_data, variables) => invalidateItemCreated(queryClient, variables.parentId),
    });
}

// DELETE FOLDER
export function useDeleteFolder(ownerId: string, parentId?: string, mimeType?: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (pathId: string) => {
            const response = await driveApi.folder({ownerId})({pathId}).delete();
            return response.data;
        },
        onSuccess: (_data, pathId) => invalidateItemDeleted(queryClient, pathId, parentId, mimeType),
    });
}

// DELETE FILE
export function useDeleteFile(ownerId: string, parentId?: string, mimeType?: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (pathId: string) => {
            const response = await driveApi.file({ownerId})({pathId}).delete();
            return response.data;
        },
        onSuccess: (_data, pathId) => invalidateItemDeleted(queryClient, pathId, parentId, mimeType),
    });
}

export function useMovePath(ownerId: string, currentParentId?: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({pathId, targetParentId}: { pathId: string, targetParentId: string }) => {
            const response = await driveApi.path.move({ownerId})({pathId}).put({targetParentId});
            return response.data;
        },
        onSuccess: (_data, variables) => invalidatePathMoved(queryClient, variables.pathId, variables.targetParentId, currentParentId),
    });
}

export function useRenamePath(ownerId: string, parentId?: string, mimeType?: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({pathId, newName}: { pathId: string, newName: string }) => {
            const response = await driveApi.path.rename({ownerId})({pathId}).put({newName});
            return response.data;
        },
        onSuccess: (_data, variables) => invalidatePathRenamed(queryClient, variables.pathId, parentId, mimeType),
    });
}

// UPDATE ACL
export function useUpdateACL(ownerId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({path, acl}: { path: DrivePath, acl: DriveACL[] }) => {
            const response = await driveApi.path.acl({ownerId})({pathId: path.id}).put({acl});
            return response.data;
        },
        onSuccess: (_data, variables) => invalidateAclUpdated(queryClient, variables.path.id, variables.path.parentId),
    });
}

// CHECK READ PERMISSION
export function useCheckReadPermission(ownerId: string, pathId: string | undefined) {
    return useQuery({
        queryKey: driveKeys.read(pathId || ''),
        queryFn: async () => {
            if (!pathId) return {canRead: false};
            const response = await driveApi.permissions.read({ownerId})({pathId}).get();
            return response.data || {canRead: false};
        },
        enabled: !!pathId
    });
}

// CHECK WRITE PERMISSION
export function useCheckWritePermission(ownerId: string, pathId: string | undefined) {
    return useQuery({
        queryKey: driveKeys.write(pathId || ''),
        queryFn: async () => {
            if (!pathId) return {canWrite: false};
            const response = await driveApi.permissions.write({ownerId})({pathId}).get();
            return response.data || {canWrite: false};
        },
        enabled: !!pathId
    });
}

// GET BREADCRUMB PATH
export function useBreadcrumb(ownerId: string, pathId: string | undefined) {
    return useQuery({
        queryKey: [...driveKeys.path(pathId || ''), 'breadcrumb'],
        queryFn: async () => {
            if (!pathId) return [];
            const response = await driveApi.breadcrumb({ownerId})({pathId}).get();
            return response.data || [];
        },
        enabled: !!pathId
    });
}

// CREATE DOC
export function useCreateDoc(ownerId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({parentId, fileName}: { parentId: string, fileName: string }) => {
            const response = await driveApi.doc({ownerId})({pathId: parentId}).post({fileName});
            return response.data;
        },
        onSuccess: (_data, variables) => invalidateItemCreated(queryClient, variables.parentId, 'application/eigendoc'),
    });
}

// CREATE STICKIES
export function useCreateStickies(ownerId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({parentId, fileName}: { parentId: string, fileName: string }) => {
            const response = await driveApi.stickies({ownerId})({pathId: parentId}).post({fileName});
            return response.data;
        },
        onSuccess: (_data, variables) => invalidateItemCreated(queryClient, variables.parentId, 'application/eigenstickies'),
    });
}

export function useSharedPaths(to: 'by-me' | 'with-me') {
    return useQuery({
        queryKey: driveKeys.shared(to),
        queryFn: async () => {
            const response = await driveApi.shared[to].get();
            return response.data;
        }
    });
}

// SSE invalidation functions
export function invalidateAclSharedOrUnshared(queryClient: QueryClient): void {
    queryClient.invalidateQueries({queryKey: driveKeys.shared('with-me')});
}

export function invalidateItemCreated(queryClient: QueryClient, parentId: string | null | undefined, mimeType?: string | null): void {
    if (parentId) {
        queryClient.invalidateQueries({queryKey: driveKeys.folder(parentId)});
    }
    if (mimeType) {
        const normalizedMimeType = mimeType.replace('/', '-');
        queryClient.invalidateQueries({queryKey: driveKeys.mime(normalizedMimeType)});
    }
    invalidateHomeSize(queryClient);
}

export function invalidateItemDeleted(queryClient: QueryClient, pathId: string, parentId: string | null | undefined, mimeType: string | null | undefined): void {
    if (parentId) {
        queryClient.invalidateQueries({queryKey: driveKeys.folder(parentId)});
    }
    queryClient.removeQueries({queryKey: driveKeys.path(pathId)});
    if (mimeType) {
        const normalizedMimeType = mimeType.replace('/', '-');
        queryClient.invalidateQueries({queryKey: driveKeys.mime(normalizedMimeType)});
    }
    invalidateHomeSize(queryClient);
}

export function invalidatePathRenamed(queryClient: QueryClient, pathId: string, parentId: string | null | undefined, mimeType: string | null | undefined): void {
    queryClient.invalidateQueries({queryKey: driveKeys.path(pathId)});
    if (parentId) {
        queryClient.invalidateQueries({queryKey: driveKeys.folder(parentId)});
    }
    if (mimeType) {
        const normalizedMimeType = mimeType.replace('/', '-');
        queryClient.invalidateQueries({queryKey: driveKeys.mime(normalizedMimeType)});
    }
}

export function invalidatePathMoved(queryClient: QueryClient, pathId: string, parentId: string | null | undefined, oldParentId: string | null | undefined): void {
    queryClient.invalidateQueries({queryKey: driveKeys.path(pathId)});
    if (parentId) {
        queryClient.invalidateQueries({queryKey: driveKeys.folder(parentId)});
    }
    if (oldParentId) {
        queryClient.invalidateQueries({queryKey: driveKeys.folder(oldParentId)});
    }
}

export function invalidateAclUpdated(queryClient: QueryClient, pathId: string, parentId: string | null | undefined): void {
    queryClient.invalidateQueries({queryKey: driveKeys.shared('by-me')});
    queryClient.invalidateQueries({queryKey: driveKeys.shared('with-me')});
    queryClient.invalidateQueries({queryKey: driveKeys.path(pathId)});
    if (parentId) {
        queryClient.invalidateQueries({queryKey: driveKeys.folder(parentId)});
    }
}

