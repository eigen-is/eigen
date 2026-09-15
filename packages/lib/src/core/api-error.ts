import { toast } from 'sonner';
import { isRecord } from './guards';

const STATUS_MESSAGES: Record<number, string> = {
    400: 'Invalid request',
    401: 'Not signed in',
    403: 'No access',
    404: 'Not found',
    409: 'Conflict',
    413: 'Too large',
    422: 'Invalid request',
    429: 'Too many requests',
    500: 'Server error',
    503: 'Service unavailable',
    507: 'Insufficient storage',
};

function readString(source: Record<string, unknown>, key: string): string | undefined {
    const field = source[key];
    return typeof field === 'string' && field.trim() !== '' ? field.trim() : undefined;
}

// Elysia keeps a validation error's `message` and `summary` out of production bodies — a rejected schema
// arrives as `{ type, on, found }`, with nothing to read — so the status has to carry the meaning there.
function messageFromBody(value: unknown, status: number): string {
    const fallback = STATUS_MESSAGES[status] ?? 'Request failed';
    if (typeof value === 'string') return value.trim() || fallback;
    if (isRecord(value)) {
        const first = Array.isArray(value.errors) ? value.errors[0] : null;
        const firstDetail = isRecord(first)
            ? (readString(first, 'summary') ?? readString(first, 'message'))
            : undefined;
        return readString(value, 'message') ?? readString(value, 'summary') ?? firstDetail ?? fallback;
    }
    return value === null || value === undefined || Array.isArray(value) ? fallback : String(value);
}

export class AppError extends Error {
    status: number;

    // error.status is `unknown`, not `number`: the untyped-error GET routes (/p/config, /settings/server,
    // /settings/s3config) declare no response schema, so Eden can't enumerate their codes. Coerced below.
    constructor(response: { error: { status: unknown; value: unknown } | null; status: number }) {
        const errorStatus = response.error?.status;
        const status = typeof errorStatus === 'number' ? errorStatus : response.status;
        super(messageFromBody(response.error?.value, status));
        this.status = status;
    }
}

// The retry every preview that runs a transform shares: the runner's queue is bounded, so its "busy"
// (503) is worth another go, while a file the parser refuses fails the same way every time.
export function retryWhenTransformBusy(failureCount: number, error: unknown): boolean {
    return failureCount < 3 && error instanceof AppError && error.status === 503;
}

export function getErrorMessage(error: unknown): string {
    if (error instanceof AppError) return `${error.message} (${error.status})`;
    if (error instanceof Error) return error.message;
    return String(error);
}

// Errors onMutationError has already shown a toast for, so a caller that also sees the rejection
// (CardForm) can swallow exactly those and let anything else surface.
const toastedErrors = new WeakSet<object>();

export function onMutationError(error: unknown): void {
    if (error !== null && typeof error === 'object') toastedErrors.add(error);
    toast.error(getErrorMessage(error));
}

export function wasToasted(error: unknown): boolean {
    return error !== null && typeof error === 'object' && toastedErrors.has(error);
}
