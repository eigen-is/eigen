// The version that names a collab document's stored state for a reader who gets no socket: the home's data epoch, the
// newest snapshot and the last update, and the format of the body. The server's state route sends it as its ETag and
// caches the body under it, and useCollabDoc reads the epoch back out, to reload the tab when the home was replaced.

export function collabStateVersion(epoch: string, snapshotId: number, lastUpdateId: number, format: string): string {
    return `${epoch}.${snapshotId}.${lastUpdateId}.${format}`;
}

// A proxy that compresses the body may make the tag weak or add to its end, so the epoch is all before the last three
// parts.
export function collabStateEpoch(etag: string): string {
    return etag.replace(/^W\//, '').slice(1).split('.').slice(0, -3).join('.');
}
