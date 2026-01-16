// Re-export types that might be useful for consumers
export type {UploadItem} from "./upload-provider"

// Helper function for handling file upload with progress tracking
interface UploadWithProgressOptions {
    url: string
    formData: FormData
    onProgress?: (progress: number) => void
    onSuccess?: (resp: Response) => void
    onError?: (error: Error) => void
    headers?: Record<string, string>
}

export async function uploadWithProgress({
                                             url,
                                             formData,
                                             onProgress,
                                             onSuccess,
                                             onError,
                                             headers: _headers = {}
                                         }: UploadWithProgressOptions): Promise<Response> {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.withCredentials = true;
        xhr.open("POST", url);

        // Set authentication and other headers
        // Object.entries(headers).forEach(([key, value]) => {
        //     xhr.setRequestHeader(key, value)
        // })

        xhr.upload.onprogress = (event) => {
            if (event.lengthComputable && onProgress) {
                const progress = Math.round((event.loaded / event.total) * 100)
                onProgress(progress)
            }
        }

        xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
                if (onSuccess) onSuccess(xhr.response)
                resolve(new Response(xhr.response, {
                    status: xhr.status,
                    statusText: xhr.statusText
                }))
            } else {
                const error = new Error(`HTTP Error: ${xhr.status}`)
                if (onError) onError(error)
                reject(error)
            }
        }

        xhr.onerror = () => {
            const error = new Error("Network Error")
            if (onError) onError(error)
            reject(error)
        }

        xhr.send(formData)
    })
}
