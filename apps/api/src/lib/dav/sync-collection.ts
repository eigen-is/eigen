import { formatSyncToken, invalidSyncToken, parseSyncToken } from './sync-token';
import { multistatusResponse, removedRow } from './xml';

// One collection's store seams; `row` builds a member's response, and a member gone by its read answers `removedRow`.
export type SyncCollection<Row> = {
    state: { syncGen: number; ctag: number };
    list: () => Promise<Row[]>;
    changedSince: (ctag: number) => Promise<Row[]>;
    deletedSince: (ctag: number) => Promise<{ uri: string }[]>;
    href: (uri: string) => string;
    row: (row: Row) => Promise<string>;
};

// RFC 6578 sync-collection for CalDAV and CardDAV alike.
export async function handleSyncCollection<Row>(
    syncToken: string | undefined,
    collection: SyncCollection<Row>,
): Promise<Response> {
    const responses: string[] = [];

    if (!syncToken) {
        // Initial sync — the whole collection as 200 rows.
        for (const row of await collection.list()) responses.push(await collection.row(row));
    } else {
        const token = parseSyncToken(syncToken);
        if (!token) return invalidSyncToken();
        // A stale generation or a ctag ahead of the collection forces a resync: an empty delta under a lower token stalls the client forever.
        if (token.gen !== collection.state.syncGen || token.since > collection.state.ctag) return invalidSyncToken();

        for (const row of await collection.changedSince(token.since)) responses.push(await collection.row(row));
        // One tombstone row per uri: no href may be both a 200 and a 404 in one response.
        for (const removed of await collection.deletedSince(token.since)) {
            responses.push(removedRow(collection.href(removed.uri)));
        }
    }

    // The current token is appended after the responses.
    return multistatusResponse(responses, `<D:sync-token>${formatSyncToken(collection.state)}</D:sync-token>`);
}
