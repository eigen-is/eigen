import React, {useEffect, useRef} from 'react';
import {toast} from "sonner";
import {DrivePath} from "@workspace/lib/types/drive";
import {useInvalidateFolder} from "@workspace/lib/drive";
import {invalidateHomeSize} from "@workspace/lib/home";
import {useQueryClient} from "@tanstack/react-query";
import {useUpload} from "../../layout/upload-provider/upload-provider";
import {uploadWithProgress} from "../../layout/upload-provider/upload-with-progress";

export interface UploadResult {
    success: boolean;
    fileName: string;
    error?: any;
}

export interface DriveUploadFilesProps {
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
    const invalidateFolder = useInvalidateFolder();
    const queryClient = useQueryClient();
    const upload = useUpload();

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
            ? `${import.meta.env.VITE_API_HOST}/drive/files/${path.ownerId}/${path.id}`
            : `${import.meta.env.VITE_API_HOST}/drive/file/${path.ownerId}/${path.id}`;

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

                    // Show success message
                    toast.success(`${multipleFiles ? 'Files' : `File "${name}"`} uploaded successfully`);

                    // Invalidate queries to refresh folder contents
                    invalidateFolder(path.id);
                    invalidateHomeSize(queryClient);

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
        } catch (err: any) {
            uploadHandler.error();
            toast.error(`Upload failed: ${err.message || 'Unknown error'}`);
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
