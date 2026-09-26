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
    console.error('API Error:', error);
    set.status = 500;
    return 'Internal server error';
}
