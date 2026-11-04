// How long a part of a document stays after it was last used, whatever names it: a media file from its upload, a
// comment thread from its last message. An upload lands before the edit that names it reaches the server, and a tab
// that was offline may still hold such an edit. The server's sweep keeps such parts, and a screen that explains the
// sweep, such as the Delete history dialog, says how long.

export const SWEEP_GRACE_DAYS = 3;
export const SWEEP_GRACE_MS = SWEEP_GRACE_DAYS * 24 * 60 * 60 * 1000;
