// What the collab socket's two ends agree on: the close codes the server sends and the tab acts on, and the one frame
// of its own. Spelled here because the API and every editor's hook both read them.

// Collab WS close for any server-side (5xx) failed open, unreachable storage first (RFC 6455 "try again later"):
// the client retries. Any other failed open, such as a document in the trash, keeps 1008.
export const COLLAB_STORAGE_UNAVAILABLE_CLOSE = 1013;
export const COLLAB_STORAGE_UNAVAILABLE_REASON = 'storage-unavailable';
// Collab WS close for a home replaced by a restore (RFC 6455 "service restart"): the client reloads
// onto the restored document instead of reconnecting, which would merge its stale state back in.
export const COLLAB_HOME_REPLACED_CLOSE = 1012;
// The reason beside it, spelled once for both senders: the eviction sweep and the route that meets
// a home already being restored.
export const COLLAB_HOME_REPLACED_REASON = 'home-replaced';
// Collab WS frame type, outside y-websocket's 0-3, that hands a tab the data epoch it reconnects with: a tab naming
// another epoch loaded its document before a whole-server restore, and is closed like a home replaced.
export const COLLAB_EPOCH_MESSAGE = 100;
// Collab WS close for a document whose stored data is gone (4400-4499 is y-websocket's own terminal band, mirroring
// HTTP 4xx): the client stops reconnecting and shows the recoveries instead of retrying an object that will not return.
export const COLLAB_STORAGE_GONE_CLOSE = 4410;
export const COLLAB_STORAGE_GONE_REASON = 'storage-gone';
// Collab WS close for a reader who may not read this document, whether they just lost it or never had it. It sits in
// the same terminal band: the client stops reconnecting and reloads onto the screen the page now shows them.
export const COLLAB_ACCESS_LOST_CLOSE = 4403;
