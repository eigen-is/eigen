import type React from 'react';
import { createContext, useContext, useState } from 'react';
import { UploadContainer } from './upload-container';

type UploadStatus = 'uploading' | 'completed' | 'error';
type UploadId = string;

export type UploadItem = {
    id: UploadId;
    filename: string;
    progress: number;
    status: UploadStatus;
    errorMessage?: string;
    cancelFn?: () => void;
};

type UploadContextValue = {
    createUpload: (
        filename: string,
        cancelFn?: () => void,
    ) => {
        id: UploadId;
        updateProgress: (progress: number) => void;
        complete: () => void;
        error: (message?: string) => void;
        cancel: () => void;
    };
    removeUpload: (id: UploadId) => void;
};

const UploadContext = createContext<UploadContextValue | undefined>(undefined);

export function UploadProvider({ children }: { children: React.ReactNode }) {
    const [uploads, setUploads] = useState<UploadItem[]>([]);

    const contextValue: UploadContextValue = {
        createUpload: (filename, cancelFn) => {
            const id = crypto.randomUUID();

            const newUpload: UploadItem = {
                id,
                filename,
                progress: 0,
                status: 'uploading',
                cancelFn,
            };

            setUploads((prev) => [...prev, newUpload]);

            return {
                id,
                updateProgress: (progress) => {
                    setUploads((prev) => prev.map((upload) => (upload.id === id ? { ...upload, progress } : upload)));
                },
                complete: () => {
                    setUploads((prev) =>
                        prev.map((upload) =>
                            upload.id === id ? { ...upload, status: 'completed', progress: 100 } : upload,
                        ),
                    );
                    // Auto-remove after 1 second
                    setTimeout(() => {
                        setUploads((prev) => prev.filter((upload) => upload.id !== id));
                    }, 1000);
                },
                error: (message) => {
                    setUploads((prev) =>
                        prev.map((upload) =>
                            upload.id === id ? { ...upload, status: 'error', errorMessage: message } : upload,
                        ),
                    );
                    // Auto-remove after 3 seconds
                    setTimeout(() => {
                        setUploads((prev) => prev.filter((upload) => upload.id !== id));
                    }, 3000);
                },
                cancel: () => {
                    // Call the cancelFn if it exists
                    if (cancelFn) cancelFn();
                    setUploads((prev) => prev.filter((upload) => upload.id !== id));
                },
            };
        },
        removeUpload: (id) => {
            // Get the upload to check if it has a cancelFn
            const upload = uploads.find((u) => u.id === id);
            if (upload?.cancelFn) upload.cancelFn();

            setUploads((prev) => prev.filter((upload) => upload.id !== id));
        },
    };

    return (
        <UploadContext.Provider value={contextValue}>
            {children}
            <UploadContainer uploads={uploads} onRemove={contextValue.removeUpload} />
        </UploadContext.Provider>
    );
}

export function useUpload() {
    const context = useContext(UploadContext);
    if (!context) throw new Error('useUpload must be used within an UploadProvider');
    return context;
}
