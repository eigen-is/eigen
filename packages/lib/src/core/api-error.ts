import { toast } from 'sonner';

export class AppError extends Error {
    status: number;

    constructor(response: { error: { status: number; value: unknown } | null; status: number }) {
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
        this.status = response.error?.status ?? response.status;
    }
}

export function getErrorMessage(error: unknown): string {
    if (error instanceof AppError) return `${error.message} (${error.status})`;
    if (error instanceof Error) return error.message;
    return String(error);
}

export function onMutationError(error: unknown): void {
    toast.error(getErrorMessage(error));
}
