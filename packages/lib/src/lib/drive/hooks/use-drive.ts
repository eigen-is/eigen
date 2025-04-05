import {useMutation, useQuery, useQueryClient} from "@tanstack/react-query";
import type {DriveACL} from "@apps/api-server/types/drive";
import {driveApi} from "@workspace/lib/api";
import {invalidateHomeSize} from "../../home";

// Define query keys for reuse
export const driveKeys = {
    all: ['drive'] as const,
    root: () => [...driveKeys.all, 'root'] as const,
    folders: () => [...driveKeys.all, 'folder'] as const,
    folder: (pathId: string) => [...driveKeys.folders(), pathId] as const,
    paths: () => [...driveKeys.all, 'path'] as const,
    path: (pathId: string) => [...driveKeys.paths(), pathId] as const,
    permissions: () => [...driveKeys.all, 'permissions'] as const,
    read: (pathId: string) => [...driveKeys.permissions(), 'read', pathId] as const,
    write: (pathId: string) => [...driveKeys.permissions(), 'write', pathId] as const,
};

// GET ROOT FOLDER
export function useRootFolder() {
    return useQuery({
        queryKey: driveKeys.root(),
        queryFn: async () => {
            const response = await driveApi.root.get();
            return response.data;
        },
        staleTime: Infinity
    });
}

// GET FOLDER CONTENTS
export function useFolderContent(pathId: string) {
    return useQuery({
        queryKey: driveKeys.folder(pathId),
        queryFn: async () => {
            if (!pathId) return [];
            const response = await driveApi.folder[pathId].get();
            return response.data || [];
        },
        enabled: !!pathId,
        staleTime: 1000 * 60 * 5 // 5 minutes
    });
}

// GET PATH INFO
export function usePathInfo(pathId: string | undefined) {
    return useQuery({
        queryKey: driveKeys.path(pathId || ''),
        queryFn: async () => {
            if (!pathId) return null;
            const response = await driveApi.path[pathId].get();
            return response.data || null;
        },
        enabled: !!pathId,
        staleTime: 1000 * 60 * 5 // 5 minutes
    });
}

// CREATE FOLDER
export function useCreateFolder() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: async ({parentId, folderName}: { parentId: string, folderName: string }) => {
            const response = await driveApi.folder.post({
                parentId,
                folderName
            });
            return response.data;
        },
        onSuccess: (_, variables) => {
            queryClient.invalidateQueries({queryKey: driveKeys.folder(variables.parentId)});
        }
    });
}

// UPLOAD FILE
export function useUploadFile() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: async ({parentId, file}: { parentId: string, file: File }) => {
            const response = await driveApi.file.post({
                parentId,
                file
            });
            return response.data;
        },
        onSuccess: (_, variables) => {
            queryClient.invalidateQueries({queryKey: driveKeys.folder(variables.parentId)});
            invalidateHomeSize(queryClient);
        }
    });
}


// UPLOAD FILE
export function useUploadFiles() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: async ({parentId, files}: { parentId: string, files: File[] }) => {
            const response = await driveApi.files.post({
                parentId,
                files
            });
            return response.data;
        },
        onSuccess: (_, variables) => {
            queryClient.invalidateQueries({queryKey: driveKeys.folder(variables.parentId)});
            invalidateHomeSize(queryClient);
        }
    });
}

export function useInvalidateFolder() {
    const queryClient = useQueryClient();

    return (pathId: string) => {
        queryClient.invalidateQueries({queryKey: driveKeys.folder(pathId)});
    };
}

// DELETE FOLDER
export function useDeleteFolder() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: async (pathId: string) => {
            const response = await driveApi.folder[pathId].delete();
            return response.data;
        },
        onSuccess: () => {
            // We don't know the parent ID here, so we invalidate all folders
            queryClient.invalidateQueries({queryKey: driveKeys.folders()});
            invalidateHomeSize(queryClient);
        }
    });
}

// DELETE FILE
export function useDeleteFile() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: async (pathId: string) => {
            const response = await driveApi.file[pathId].delete();
            return response.data;
        },
        onSuccess: () => {
            // We don't know the parent ID here, so we invalidate all folders
            queryClient.invalidateQueries({queryKey: driveKeys.folders()});
            invalidateHomeSize(queryClient);
        }
    });
}

// RENAME PATH (FILE OR FOLDER)
export function useRenamePath() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: async ({pathId, newName}: { pathId: string, newName: string }) => {
            const response = await driveApi.path.rename.put({
                pathId,
                newName
            });
            return response.data;
        },
        onSuccess: () => {
            queryClient.invalidateQueries({queryKey: driveKeys.all});
        }
    });
}

// UPDATE ACL
export function useUpdateACL() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: async ({pathId, acl}: { pathId: string, acl: DriveACL[] }) => {
            const response = await driveApi.path.acl.put({
                pathId,
                acl
            });
            return response.data;
        },
        onSuccess: (_, variables) => {
            queryClient.invalidateQueries({queryKey: driveKeys.path(variables.pathId)});
        }
    });
}

// CHECK READ PERMISSION
export function useCheckReadPermission(pathId: string | undefined) {
    return useQuery({
        queryKey: driveKeys.read(pathId || ''),
        queryFn: async () => {
            if (!pathId) return {canRead: false};
            const response = await driveApi.permissions.read[pathId].get();
            return response.data || {canRead: false};
        },
        enabled: !!pathId
    });
}

// CHECK WRITE PERMISSION
export function useCheckWritePermission(pathId: string | undefined) {
    return useQuery({
        queryKey: driveKeys.write(pathId || ''),
        queryFn: async () => {
            if (!pathId) return {canWrite: false};
            const response = await driveApi.permissions.write[pathId].get();
            return response.data || {canWrite: false};
        },
        enabled: !!pathId
    });
}
