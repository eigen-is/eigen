import {useRef} from 'react';
import {useUpload} from "../../layout/upload-provider/upload-provider";
import {uploadWithProgress} from "../../layout/upload-provider/upload-with-progress";

// Interface for upload result
export interface UploadResult {
    success: boolean;
    fileName: string;
    error?: any;
}

// Interface for upload options
export interface FileUploadOptions {
    singleFileUrl?: string;
    multipleFilesUrl?: string;
    onSuccess?: (result: UploadResult) => void;
    onError?: (result: UploadResult) => void;
    additionalHeaders?: Record<string, string>;
}

// Custom hook for file upload functionality
export function useFileUpload(ownerId: string, folderId: string, options: FileUploadOptions = {}) {
    const fileInputRef = useRef<HTMLInputElement>(null);
    const upload = useUpload();

    // Function to trigger file upload
    const handleFileUpload = () => {
        if (fileInputRef.current) {
            fileInputRef.current.click();
        }
    };

    // Function to process uploads
    const processFiles = async (files: File[]) => {
        if (files.length === 0) return;

        const multipleFiles = files.length > 1;

        // Use custom URLs if provided, otherwise use default URLs
        const url = multipleFiles
            ? (options.multipleFilesUrl || `${import.meta.env.VITE_API_HOST}/drive/files/${ownerId}/${folderId}`)
            : (options.singleFileUrl || `${import.meta.env.VITE_API_HOST}/drive/file/${ownerId}/${folderId}`);

        const name = multipleFiles ? 'multiple files' : files[0].name;
        const uploadHandler = upload.createUpload(name);

        try {
            // Create FormData object for this file(s)
            const formData = new FormData();
            if (multipleFiles) {
                for (const file of files) {
                    formData.append('files', file);
                }
            } else {
                formData.append('file', files[0]);
            }

            // Combine default headers with any additional headers
            const headers = {
                'credentials': 'include',
                ...options.additionalHeaders
            };

            // Use uploadWithProgress with the appropriate options
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

                    const result = {success: true, fileName: name};

                    // Call custom onSuccess callback if provided
                    if (options.onSuccess) {
                        options.onSuccess(result);
                    }

                    return result;
                },
                onError: (err) => {
                    // Mark upload as failed
                    uploadHandler.error();

                    const result = {success: false, fileName: name, error: err};

                    // Call custom onError callback if provided
                    if (options.onError) {
                        options.onError(result);
                    }

                    return result;
                }
            });
        } catch (err: any) {
            uploadHandler.error();

            const result = {success: false, fileName: name, error: err};

            // Call custom onError callback if provided
            if (options.onError) {
                options.onError(result);
            }

            return result;
        }
    };

    // Handle file input change event
    const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = e.target.files;
        if (!files || files.length === 0) return;

        await processFiles(Array.from(files));

        // Reset file input value so the same files can be selected again if needed
        e.target.value = '';
    };

    return {
        fileInputRef,
        handleFileUpload,
        processFiles,
        handleFileChange
    };
}
