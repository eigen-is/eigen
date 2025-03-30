export { UploadProvider, useUpload } from "./upload-provider"

// Re-export types that might be useful for consumers
export type { UploadItem } from "./upload-provider"

// Helper function for handling file upload with progress tracking
interface UploadWithProgressOptions {
  url: string
  formData: FormData
  onProgress?: (progress: number) => void
  onSuccess?: () => void
  onError?: (error: Error) => void
}

export async function uploadWithProgress({
  url,
  formData,
  onProgress,
  onSuccess,
  onError
}: UploadWithProgressOptions): Promise<Response> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open("POST", url)
    
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) {
        const progress = Math.round((event.loaded / event.total) * 100)
        onProgress(progress)
      }
    }
    
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        if (onSuccess) onSuccess()
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
