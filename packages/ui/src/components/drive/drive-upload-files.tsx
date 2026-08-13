import { useQueryClient } from '@tanstack/react-query';
import { getDriveFileUploadUrl } from '@workspace/lib/api';
import { invalidateItemCreated } from '@workspace/lib/drive';
import type { DrivePath } from '@workspace/lib/types/drive';
import type React from 'react';
import { useEffect, useRef } from 'react';
import { useUpload } from '../upload-provider/upload-provider';
import { uploadWithProgress } from '../upload-provider/upload-with-progress';

export type DriveUploadFilesProps = {
    path: DrivePath;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onAfterAction?: (actionType: string, data: Record<string, unknown>) => void;
    initialFiles?: File[];
    onAfterUpload?: () => void;
};

export function DriveUploadFiles({
    path,
    open,
    onOpenChange,
    onAfterAction,
    initialFiles = [],
    onAfterUpload,
}: DriveUploadFilesProps) {
    const fileInputRef = useRef<HTMLInputElement>(null);
    const upload = useUpload();
    const queryClient = useQueryClient();

    // Process initial files when they're provided and component is opening
    useEffect(() => {
        if (open && initialFiles.length > 0) {
            processFiles(initialFiles);
            // Reset files after processing
            if (onAfterUpload) {
                onAfterUpload();
            }
            // Close the dialog immediately to avoid further processing
            onOpenChange(false);
        }
    }, [open, initialFiles]);

    // Trigger file input click when open changes to true
    if (open && fileInputRef.current && initialFiles.length === 0) {
        setTimeout(() => {
            fileInputRef.current?.click();
            // Close dialog immediately as we don't need to keep it open
            // The file picker dialog will take over
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

            // Invalidate the parent folder cache so new files appear
            invalidateItemCreated(queryClient, path.ownerId, path.mountId, path.id);
            onAfterAction?.('upload', { success: true, fileName: name, files: files.length });
        } catch (err: unknown) {
            uploadHandler.error(err instanceof Error ? err.message : undefined);
        }
    };

    const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = e.target.files;
        if (!files || files.length === 0) return;

        await processFiles(Array.from(files));

        // Reset file input value so the same files can be selected again if needed
        e.target.value = '';
    };

    return <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileChange} />;
}
