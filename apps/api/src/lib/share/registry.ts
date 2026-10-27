// The share registry: a server-wide list of "this owner shared something with this address or team". A share
// writes an entry when its target may appear later, such as an address with no account yet or a team, and reconciliation reads
// the entries when an account or a membership appears. An entry holds no share data, and a reader is never
// handed more than the owner's id, so it grants nothing by itself. Targets are stored lowercased.

import { eq } from 'drizzle-orm';
import { getEigenDb } from './db';
import { shareRegistry } from './schema';

export async function addRegistryEntry(fromUserId: string, targetIdentifier: string): Promise<void> {
    const db = await getEigenDb();
    db.insert(shareRegistry)
        .values({ fromUserId, targetIdentifier: targetIdentifier.toLowerCase() })
        .onConflictDoNothing()
        .run();
}

export async function getEntriesForTarget(identifier: string): Promise<string[]> {
    const db = await getEigenDb();
    const rows = db
        .select({ fromUserId: shareRegistry.fromUserId })
        .from(shareRegistry)
        .where(eq(shareRegistry.targetIdentifier, identifier.toLowerCase()))
        .all();
    return rows.map((row) => row.fromUserId);
}

export async function removeEntriesForTarget(targetIdentifier: string): Promise<void> {
    const db = await getEigenDb();
    db.delete(shareRegistry).where(eq(shareRegistry.targetIdentifier, targetIdentifier.toLowerCase())).run();
}

export async function removeEntriesFromSource(fromUserId: string): Promise<void> {
    const db = await getEigenDb();
    db.delete(shareRegistry).where(eq(shareRegistry.fromUserId, fromUserId)).run();
}
