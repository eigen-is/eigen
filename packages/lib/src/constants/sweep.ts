// How long the server's sweep keeps a part of a document that nothing names any more, such as a media file counted
// from its upload or a comment thread counted from its last message. An upload lands before the edit that names it
// reaches the server, and a tab that was offline may still hold such an edit. A screen that explains the sweep, such
// as the Delete history dialog, says how long.

export const SWEEP_GRACE_DAYS = 3;
export const SWEEP_GRACE_MS = SWEEP_GRACE_DAYS * 24 * 60 * 60 * 1000;
