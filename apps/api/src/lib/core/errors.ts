import type { Context } from 'elysia';

export class ApiError extends Error {
    constructor(
        public status: number,
        message: string,
        options?: ErrorOptions,
    ) {
        super(message, options);
    }
}

// The one 503 a storage outage answers; an ApiError already on its way out passes through.
export function storageUnavailable(cause?: unknown): ApiError {
    if (cause instanceof ApiError) return cause;
    return new ApiError(503, 'Storage unavailable', cause === undefined ? undefined : { cause });
}

// A stored object that is gone for good, after the temp and the staged copy were checked: 410, as the row
// still resolves.
export function storageGone(cause?: unknown): ApiError {
    return new ApiError(410, 'Stored data not found', cause === undefined ? undefined : { cause });
}

// The one 413 a body or a read past its cap answers.
export function payloadTooLarge(): ApiError {
    return new ApiError(413, 'Upload too large');
}

// An overwrite whose base updatedAt the file no longer carries; the inline editor answers it as a conflict.
export class StaleWriteError extends ApiError {
    constructor(readonly currentUpdatedAt: Date) {
        super(409, 'File changed since it was loaded');
    }
}

type ErrorHandlerContext = { error: unknown; code: unknown; set: Context['set']; request: Request };

export function handleApiError({ error, code, set, request }: ErrorHandlerContext): string | undefined {
    if (code === 'VALIDATION') return;
    if (error instanceof ApiError) {
        set.status = error.status;
        if (error.status === 401) {
            const pathname = new URL(request.url).pathname;
            if (pathname.startsWith('/dav')) {
                set.headers['WWW-Authenticate'] = 'Basic realm="Eigen DAV"';
            } else if (pathname.startsWith('/webdav')) {
                set.headers['WWW-Authenticate'] = 'Basic realm="Eigen Drive"';
            }
        }
        return error.message;
    }
    // A caller who left mid-wait: nobody reads the answer, and nothing went wrong on our side.
    if (error instanceof Error && error.name === 'AbortError') {
        set.status = 499;
        return 'Client closed request';
    }
    console.error('API Error:', error);
    set.status = 500;
    return 'Internal server error';
}
