import { toast } from 'sonner';

export class AppError extends Error {
    status: number;

    // error.status is `unknown`, not `number`: the untyped-error GET routes (/p/config, /settings/server,
    // /settings/s3config) declare no response schema, so Eden can't enumerate their codes. Coerced below.
    constructor(response: { error: { status: unknown; value: unknown } | null; status: number }) {
        const value = response.error?.value;
        const message =
            typeof value === 'string'
                ? value
                : value && typeof value === 'object' && 'message' in value
                  ? String(
                        (
                            value as {
                                message: unknown;
                            }
                        ).message,
                    )
                  : String(value ?? 'Unknown error');
        super(message);
        const errorStatus = response.error?.status;
        this.status = typeof errorStatus === 'number' ? errorStatus : response.status;
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
