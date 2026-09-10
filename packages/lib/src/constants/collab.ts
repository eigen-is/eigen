// Collab WS close for unreachable storage (RFC 6455 "try again later"): the client retries; other closes keep 1008.
export const COLLAB_STORAGE_UNAVAILABLE_CLOSE = 1013;
// Collab WS close for a home replaced by a restore (RFC 6455 "service restart"): the client reloads
// onto the restored document instead of reconnecting, which would merge its stale state back in.
export const COLLAB_HOME_REPLACED_CLOSE = 1012;
// The reason beside it, spelled once for both senders: the eviction sweep and the route that meets
// a home already being restored.
export const COLLAB_HOME_REPLACED_REASON = 'home-replaced';
