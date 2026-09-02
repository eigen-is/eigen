// Close code the collab WS route sends when a document's storage is unreachable (RFC 6455 "try again
// later"), and the client's cue to say "retrying" instead of an access error. Every other failed open
// keeps 1008.
export const COLLAB_STORAGE_UNAVAILABLE_CLOSE = 1013;
