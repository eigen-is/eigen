// Drive's Upload files into one folder, from the browser's file picker or from files dropped on the list. Each
// batch is one upload with one row in the upload provider, which draws its progress and cancels it. A host such as
// the Drive action runner calls pickFiles or upload, and renders the hidden input the picker needs.

import { useUploadFiles } from '@workspace/lib/drive';
import type { DrivePath } from '@workspace/lib/types/drive';
import type { ReactNode } from 'react';
import { useRef } from 'react';
import { useUpload } from '../upload-provider/upload-provider';

export function useDriveUploadFiles(
    folder: DrivePath | null,
    onAfterAction?: (actionType: string, data: Record<string, unknown>) => void,
): { pickFiles: () => void; upload: (files: File[]) => void; input: ReactNode } {
    const inputRef = useRef<HTMLInputElement>(null);
    const uploads = useUpload();
    const { mutateAsync: uploadFiles } = useUploadFiles();

    const upload = (files: File[]) => {
        if (!folder || files.length === 0) return;
        const name = files.length > 1 ? 'multiple files' : files[0].name;
        const controller = new AbortController();
        const row = uploads.createUpload(name, () => controller.abort());
        // The hook toasts a failure; the row only shows it failed.
        uploadFiles({ folder, files, onProgress: row.updateProgress, signal: controller.signal }).then(
            () => {
                row.complete();
                onAfterAction?.('upload', { fileName: name, files: files.length });
            },
            () => row.error(),
        );
    };

    const input = (
        <input
            ref={inputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(event) => {
                upload(Array.from(event.target.files ?? []));
                // Emptied, so picking the same files again fires a change.
                event.target.value = '';
            }}
        />
    );

    return { pickFiles: () => inputRef.current?.click(), upload, input };
}
