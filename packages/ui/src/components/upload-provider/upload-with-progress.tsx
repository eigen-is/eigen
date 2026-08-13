type UploadWithProgressOptions = {
    url: string;
    formData: FormData;
    onProgress?: (progress: number) => void;
};

// Promise-only: resolve with the response body on success, reject once on any failure. A single
// outcome channel keeps callers from running their error path twice.
export async function uploadWithProgress({ url, formData, onProgress }: UploadWithProgressOptions): Promise<string> {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.withCredentials = true;
        xhr.open('POST', url);

        xhr.upload.onprogress = (event) => {
            if (event.lengthComputable && onProgress) {
                onProgress(Math.round((event.loaded / event.total) * 100));
            }
        };

        xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
                resolve(xhr.responseText);
            } else {
                // Surface the server's error body so the failure is actionable, not a bare status.
                reject(new Error(xhr.responseText || `Upload failed (${xhr.status})`));
            }
        };

        xhr.onerror = () => reject(new Error('Network Error'));

        xhr.send(formData);
    });
}
