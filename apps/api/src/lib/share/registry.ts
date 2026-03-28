import { and, eq, inArray } from 'drizzle-orm';
import { getEigenDb } from './db';
import { shareRegistry } from './schema';

export async function addRegistryEntry(fromUserId: string, targetIdentifier: string): Promise<void> {
    const db = await getEigenDb();
    db.insert(shareRegistry)
        .values({ fromUserId, targetIdentifier: targetIdentifier.toLowerCase() })
        .onConflictDoNothing()
        .run();
}

export async function removeRegistryEntries(fromUserId: string, targetIdentifier: string): Promise<void> {
    const db = await getEigenDb();
    db.delete(shareRegistry)
        .where(
            and(
                eq(shareRegistry.fromUserId, fromUserId),
                eq(shareRegistry.targetIdentifier, targetIdentifier.toLowerCase()),
            ),
        )
        .run();
}

export async function getEntriesForTarget(identifier: string): Promise<string[]> {
    const db = await getEigenDb();
    const rows = db
        .select({ fromUserId: shareRegistry.fromUserId })
        .from(shareRegistry)
        .where(eq(shareRegistry.targetIdentifier, identifier.toLowerCase()))
        .all();
    return rows.map((r) => r.fromUserId);
}

export async function getEntriesForTargets(identifiers: string[]): Promise<string[]> {
    if (identifiers.length === 0) return [];
    const db = await getEigenDb();
    const normalized = identifiers.map((id) => id.toLowerCase());
    const rows = db
        .select({ fromUserId: shareRegistry.fromUserId })
        .from(shareRegistry)
        .where(inArray(shareRegistry.targetIdentifier, normalized))
        .all();
    return [...new Set(rows.map((r) => r.fromUserId))];
}

export async function removeEntriesForTarget(targetIdentifier: string): Promise<void> {
    const db = await getEigenDb();
    db.delete(shareRegistry).where(eq(shareRegistry.targetIdentifier, targetIdentifier.toLowerCase())).run();
}
