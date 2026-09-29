// How this domain reads an error, rather than how it raises one (that is ApiError, in lib/core).
// A job's one-line message and a verify failure both need it.

export function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
