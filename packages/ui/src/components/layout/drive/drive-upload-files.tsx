import React, {useEffect, useRef} from 'react';
import {toast} from "sonner";
import type {DrivePath} from "@workspace/lib/types/drive";
import {useUpload} from "../../layout/upload-provider/upload-provider";
import {uploadWithProgress} from "../upload-provider/upload-with-progress";
import {getDriveFilesUploadUrl, getDriveFileUploadUrl} from "@workspace/lib/api";
import {invalidateItemCreated} from "@workspace/lib/drive";
import {useQueryClient} from "@tanstack/react-query";
import type {UploadResult} from "./file-upload";

export type {UploadResult};

export type DriveUploadFilesProps = {
    path: DrivePath;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onAfterAction?: (actionType: string, data: any) => void;
    initialFiles?: File[];
    onAfterUpload?: () => void;
}

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

        const multipleFiles = files.length > 1;

        // Use URL based on number of files
        const url = multipleFiles
            ? getDriveFilesUploadUrl(path.ownerId, path.mountId, path.id)
            : getDriveFileUploadUrl(path.ownerId, path.mountId, path.id);

        const name = multipleFiles ? 'multiple files' : files[0].name;
        const uploadHandler = upload.createUpload(name);

        try {
            // Create FormData for the file(s)
            const formData = new FormData();
            if (multipleFiles) {
                for (const file of files) {
                    formData.append('files', file);
                }
            } else {
                formData.append('file', files[0]);
            }

            // Headers for the request
            const headers = {
                'credentials': 'include'
            };

            // Upload with progress tracking
            await uploadWithProgress({
                url,
                formData,
                headers,
                onProgress: (progress: number) => {
                    uploadHandler.updateProgress(progress);
                },
                onSuccess: async () => {
                    // Mark upload as complete
                    uploadHandler.complete();

                    // Invalidate the parent folder cache so new files appear
                    invalidateItemCreated(queryClient, path.mountId, path.id);

                    // Notify parent component
                    if (onAfterAction) {
                        onAfterAction('upload', {
                            success: true,
                            fileName: name,
                            files: multipleFiles ? files.length : 1
                        });
                    }

                    return {success: true, fileName: name};
                },
                onError: (err) => {
                    // Mark upload as failed
                    uploadHandler.error();

                    // Show error message
                    toast.error(`Failed to upload ${multipleFiles ? 'files' : `file "${name}"`}`);

                    return {success: false, fileName: name, error: err};
                }
            });
        } catch (err: unknown) {
            uploadHandler.error();
            toast.error(`Upload failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
        }
    };

    const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = e.target.files;
        if (!files || files.length === 0) return;

        await processFiles(Array.from(files));

        // Reset file input value so the same files can be selected again if needed
        e.target.value = '';
    };

    return (
        <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={handleFileChange}
        />
    );
}
