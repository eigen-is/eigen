// The upload chips in the corner of every app: a hook that sends a file, such as Drive's Upload files or a
// contact's avatar, opens a chip through useUpload and moves it to its progress, done or failed. A chip whose
// upload can be cancelled shows a cancel button. EigenApp mounts the provider around every app.

import type React from 'react';
import { createContext, useContext, useState } from 'react';
import { UploadContainer } from './upload-container';

export type UploadItem = {
    id: string;
    filename: string;
    progress: number;
    status: 'uploading' | 'completed' | 'error';
    cancelFn?: () => void;
};

type UploadContextValue = {
    createUpload: (
        filename: string,
        cancelFn?: () => void,
    ) => {
        updateProgress: (progress: number) => void;
        complete: () => void;
        error: () => void;
    };
};

const UploadContext = createContext<UploadContextValue | undefined>(undefined);

export function UploadProvider({ children }: { children: React.ReactNode }) {
    const [uploads, setUploads] = useState<UploadItem[]>([]);

    const update = (id: string, change: Partial<UploadItem>) =>
        setUploads((prev) => prev.map((upload) => (upload.id === id ? { ...upload, ...change } : upload)));
    const remove = (id: string) => setUploads((prev) => prev.filter((upload) => upload.id !== id));

    const contextValue: UploadContextValue = {
        createUpload: (filename, cancelFn) => {
            const id = crypto.randomUUID();
            setUploads((prev) => [...prev, { id, filename, progress: 0, status: 'uploading', cancelFn }]);
            return {
                updateProgress: (progress) => update(id, { progress }),
                complete: () => {
                    update(id, { status: 'completed', progress: 100 });
                    setTimeout(() => remove(id), 1000);
                },
                // A failed chip stays longer, so it is read.
                error: () => {
                    update(id, { status: 'error' });
                    setTimeout(() => remove(id), 3000);
                },
            };
        },
    };

    const cancel = (upload: UploadItem) => {
        upload.cancelFn?.();
        remove(upload.id);
    };

    return (
        <UploadContext.Provider value={contextValue}>
            {children}
            <UploadContainer uploads={uploads} onCancel={cancel} />
        </UploadContext.Provider>
    );
}

export function useUpload() {
    const context = useContext(UploadContext);
    if (!context) throw new Error('useUpload must be used within an UploadProvider');
    return context;
}
