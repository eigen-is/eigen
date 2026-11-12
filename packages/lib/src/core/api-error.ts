// How a failed request reaches the user: AppError reads a readable message and the status from what Eden or a fetch
// hands back, getErrorMessage turns it into the toast's text, and onMutationError is the onError every mutation hook
// passes to show it. onEtagWriteError is that onError for a write that sends an etag. wasToasted tells a caller that
// also sees the rejection that a toast already showed it, and isRefusal tells a dialog whether another try could help.

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
    423: 'Locked',
    429: 'Too many requests',
    500: 'Server error',
    503: 'Service unavailable',
    507: 'Insufficient storage',
};

function readString(source: Record<string, unknown>, key: string): string | undefined {
    const field = source[key];
    return typeof field === 'string' && field.trim() !== '' ? field.trim() : undefined;
}

// Elysia keeps a validation error's `message` and `summary` out of production bodies, and a rejected schema arrives
// as `{ type, on, found }` with nothing to read, so the status has to carry the meaning there.
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
    public status: number;

    // error.status is `unknown`: a route that declares no response schema leaves Eden no codes to enumerate.
    public constructor(response: { error: { status: unknown; value: unknown } | null; status: number }) {
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

// The statuses of the server's settled no, such as a team it won't delete: asking again gets the same answer. A conflict
// (409), a busy server or a lost connection may go through on another try.
const REFUSAL_STATUSES = new Set([400, 403, 404, 422, 423]);

export function isRefusal(error: unknown): boolean {
    return error instanceof AppError && REFUSAL_STATUSES.has(error.status);
}

export function getErrorMessage(error: unknown): string {
    if (error instanceof AppError) return `${error.message} (${error.status})`;
    if (error instanceof Error) return error.message;
    return String(error);
}

// Errors a toast has already been shown for, so a caller that also sees the rejection, such as CardForm, can swallow
// exactly those and let anything else surface.
const toastedErrors = new WeakSet<object>();

function markToasted(error: unknown): void {
    if (error !== null && typeof error === 'object') toastedErrors.add(error);
}

export function onMutationError(error: unknown): void {
    markToasted(error);
    toast.error(getErrorMessage(error));
}

// A 412: what the write loaded changed elsewhere first.
export function isStaleWrite(error: unknown): boolean {
    return error instanceof AppError && error.status === 412;
}

// A stale write reloads the data behind the form and says so in its own toast. The error counts as toasted either way,
// so a dialog that awaits the write doesn't log it again.
export function onEtagWriteError(error: unknown, staleMessage: string, reload: () => void): void {
    if (!isStaleWrite(error)) {
        onMutationError(error);
        return;
    }
    reload();
    markToasted(error);
    toast.error(staleMessage);
}

export function wasToasted(error: unknown): boolean {
    return error !== null && typeof error === 'object' && toastedErrors.has(error);
}

// For a form with no dialog to take the rejection: a toast has told the user, and anything else must still surface.
export function rethrowUntoasted(error: unknown): void {
    if (!wasToasted(error)) throw error;
}
