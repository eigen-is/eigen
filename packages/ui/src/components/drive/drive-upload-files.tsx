// The hidden file input behind Drive's Upload files, and the upload it starts into one folder. Opening it shows
// the browser's file picker, or uploads the files it was handed at once, such as files dropped on the list. It
// closes right away either way, and the upload provider shows the progress. The Drive action runner and Drive's
// New menu mount it.

import { useQueryClient } from '@tanstack/react-query';
import { getDriveFileUploadUrl } from '@workspace/lib/api';
import { invalidateItemCreated } from '@workspace/lib/drive';
import type { DrivePath } from '@workspace/lib/types/drive';
import type { ChangeEvent } from 'react';
import { useEffect, useRef } from 'react';
import { useUpload } from '../upload-provider/upload-provider';
import { uploadWithProgress } from '../upload-provider/upload-with-progress';

export type DriveUploadFilesProps = {
    path: DrivePath;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onAfterAction?: (actionType: string, data: Record<string, unknown>) => void;
    initialFiles?: File[];
};

export function DriveUploadFiles({
    path,
    open,
    onOpenChange,
    onAfterAction,
    initialFiles = [],
}: DriveUploadFilesProps) {
    const fileInputRef = useRef<HTMLInputElement>(null);
    const upload = useUpload();
    const queryClient = useQueryClient();

    useEffect(() => {
        if (open && initialFiles.length > 0) {
            processFiles(initialFiles);
            onOpenChange(false);
        }
    }, [open, initialFiles]);

    if (open && fileInputRef.current && initialFiles.length === 0) {
        setTimeout(() => {
            fileInputRef.current?.click();
            onOpenChange(false);
        }, 0);
    }

    const processFiles = async (files: File[]) => {
        if (files.length === 0) return;

        const url = getDriveFileUploadUrl(path.ownerId, path.mountId, path.id);
        const name = files.length > 1 ? 'multiple files' : files[0].name;
        const uploadHandler = upload.createUpload(name);

        const formData = new FormData();
        for (const file of files) {
            formData.append('file', file);
        }

        try {
            await uploadWithProgress({ url, formData, onProgress: uploadHandler.updateProgress });
            uploadHandler.complete();

            invalidateItemCreated(queryClient, path.ownerId, path.mountId, path.id);
            onAfterAction?.('upload', { success: true, fileName: name, files: files.length });
        } catch (error: unknown) {
            uploadHandler.error(error instanceof Error ? error.message : undefined);
        }
    };

    const handleFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
        const files = event.target.files;
        if (!files || files.length === 0) return;

        await processFiles(Array.from(files));

        // Emptied, so picking the same files again fires a change.
        event.target.value = '';
    };

    return <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileChange} />;
}
