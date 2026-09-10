// How this domain reads an error, rather than how it raises one (that is ApiError, in lib/core).
// Both answers are needed in several places: a job's one-line message, a verify failure, and the
// errno branches that tell "the other disk" from "the disk is full" from "the bucket is gone".

export function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

// Node puts the errno on the Error as `code`; a thrown value that is not one has none.
export function errnoOf(error: unknown): string | null {
    return error instanceof Error && 'code' in error ? String(error.code) : null;
}
