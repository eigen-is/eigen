import { randomUUID } from 'node:crypto';
import { type DrivePath, type DrivePathType, isDocumentType, stripEigenExtension } from '@workspace/lib/types/drive';
import {
    type FileEvent,
    type FileEventInput,
    type FileEventType,
    fileEventVerb,
    type PathWatchStatus,
    type WatchedItem,
} from '@workspace/lib/types/file-history';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { sendToHome } from '../home/home-relay';
import type * as schema from '../mount/schema';
import { fileEvents, paths, pathWatchers } from '../mount/schema';
import { getMemberships, getUserById, type User } from '../user';
import { canReadFromAncestors } from './acl';

const HISTORY_MAX_AGE_DAYS = 90;
const HISTORY_MAX_PER_PATH = 500;

export class FileHistory {
    constructor(
        private db: BunSQLiteDatabase<typeof schema>,
        readonly ownerId: string,
        readonly mountId: string,
    ) {}

    // Entities living inside an eigendoc/chat container (per-card comment threads,
    // attachment media, the chat/ + media/ subfolders) are container scaffolding
    // and never belong in the timeline — the container speaks through its own
    // events + client-emitted sticky-*/slide-* events. Walks the parentId chain
    // for a document-type (collab or chat) ancestor strictly above the path.
    private isContainerInternal(pathId: string): boolean {
        const ancestors = this.db.all<{ type: string }>(sql`
            WITH RECURSIVE chain(id) AS (
                SELECT ${sql.raw('parentId')} FROM ${paths} WHERE id = ${pathId} AND ${sql.raw('parentId')} IS NOT NULL
                UNION
                SELECT p.${sql.raw('parentId')} FROM ${paths} p JOIN chain c ON p.id = c.id
                WHERE p.${sql.raw('parentId')} IS NOT NULL
            )
            SELECT p.type AS type FROM ${paths} p JOIN chain c ON p.id = c.id
        `);
        return ancestors.some((a) => isDocumentType(a.type as DrivePathType));
    }

    async record(input: FileEventInput, opts?: { dedupeWindowMs?: number }): Promise<void> {
        if (this.isContainerInternal(input.pathId)) return;
        if (opts?.dedupeWindowMs) {
            const last = this.db
                .select()
                .from(fileEvents)
                .where(and(eq(fileEvents.pathId, input.pathId), eq(fileEvents.actorUserId, input.actor.id)))
                .orderBy(desc(fileEvents.createdAt))
                .limit(1)
                .get();
            if (
                last &&
                last.eventType === input.eventType &&
                JSON.stringify(last.details ?? null) === JSON.stringify(input.details ?? null) &&
                Date.now() - last.createdAt.getTime() < opts.dedupeWindowMs
            ) {
                return;
            }
        }
        this.db
            .insert(fileEvents)
            .values({
                id: randomUUID(),
                pathId: input.pathId,
                eventType: input.eventType,
                actorUserId: input.actor.id,
                actorEmail: input.actor.email,
                details: input.details ?? null,
                createdAt: new Date(),
            })
            .run();
    }

    // File: direct events. Folder/container: events on the path and every descendant
    // (recursive CTE downward), newest first.
    async list(pathId: string, opts?: { limit?: number }): Promise<FileEvent[]> {
        const limit = opts?.limit ?? 50;

        const rows = this.db.all<{
            id: string;
            pathId: string;
            eventType: string;
            actorUserId: string;
            actorEmail: string;
            details: string | null;
            createdAt: number;
            pathName: string;
            pathType: string;
        }>(sql`
            WITH RECURSIVE subtree(id) AS (
                SELECT id FROM ${paths} WHERE id = ${pathId}
                UNION ALL
                SELECT p.id FROM ${paths} p JOIN subtree s ON p.${sql.raw('parentId')} = s.id
            )
            SELECT e.id, e.pathId, e.eventType, e.actorUserId, e.actorEmail, e.details, e.createdAt,
                   p.name AS pathName, p.type AS pathType
            FROM ${fileEvents} e
            JOIN subtree st ON e.pathId = st.id
            JOIN ${paths} p ON p.id = e.pathId
            ORDER BY e.createdAt DESC
            LIMIT ${limit}
        `);

        return rows.map((row) => ({
            id: row.id,
            pathId: row.pathId,
            eventType: row.eventType as FileEventType,
            actorUserId: row.actorUserId,
            actorEmail: row.actorEmail,
            details: row.details != null ? (JSON.parse(row.details) as never) : null,
            createdAt: new Date(row.createdAt * 1000),
            pathName: row.pathName,
            pathType: row.pathType as FileEvent['pathType'],
        }));
    }

    addWatcher(pathId: string, userId: string): void {
        this.db.insert(pathWatchers).values({ pathId, userId, createdAt: new Date() }).onConflictDoNothing().run();
    }

    removeWatcher(pathId: string, userId: string): void {
        this.db
            .delete(pathWatchers)
            .where(and(eq(pathWatchers.pathId, pathId), eq(pathWatchers.userId, userId)))
            .run();
    }

    getWatchStatus(pathId: string, userId: string): PathWatchStatus {
        const direct = this.db
            .select({ pathId: pathWatchers.pathId })
            .from(pathWatchers)
            .where(and(eq(pathWatchers.pathId, pathId), eq(pathWatchers.userId, userId)))
            .get();

        // Nearest watched ancestor: walk the parentId chain upward, excluding the path itself
        const [ancestor] = this.db.all<{ pathId: string; name: string }>(sql`
            WITH RECURSIVE chain(id, depth) AS (
                SELECT ${sql.raw('parentId')}, 1 FROM ${paths} WHERE id = ${pathId} AND ${sql.raw('parentId')} IS NOT NULL
                UNION ALL
                SELECT p.${sql.raw('parentId')}, c.depth + 1 FROM ${paths} p JOIN chain c ON p.id = c.id
                WHERE p.${sql.raw('parentId')} IS NOT NULL
            )
            SELECT pw.pathId AS pathId, p.name AS name
            FROM chain c
            JOIN ${pathWatchers} pw ON pw.pathId = c.id AND pw.userId = ${userId}
            JOIN ${paths} p ON p.id = c.id
            ORDER BY c.depth ASC
            LIMIT 1
        `);

        return {
            direct: !!direct,
            ...(ancestor ? { viaAncestor: { pathId: ancestor.pathId, name: ancestor.name } } : {}),
        };
    }

    listWatchedBy(userId: string): WatchedItem[] {
        const rows = this.db.all<{
            pathId: string;
            name: string;
            type: string;
            mimeType: string;
            watchedAt: number;
            lastEventAt: number | null;
            lastEventType: string | null;
        }>(sql`
            SELECT pw.pathId AS pathId, p.name AS name, p.type AS type, p.mimeType AS mimeType,
                   pw.createdAt AS watchedAt,
                   e.createdAt AS lastEventAt, e.eventType AS lastEventType
            FROM ${pathWatchers} pw
            JOIN ${paths} p ON p.id = pw.pathId
            LEFT JOIN ${fileEvents} e ON e.id = (
                SELECT id FROM ${fileEvents} WHERE pathId = pw.pathId ORDER BY createdAt DESC LIMIT 1
            )
            WHERE pw.userId = ${userId}
        `);

        return rows.map((row) => ({
            ownerId: this.ownerId,
            mountId: this.mountId,
            pathId: row.pathId,
            name: row.name,
            type: row.type as WatchedItem['type'],
            mimeType: row.mimeType,
            watchedAt: new Date(row.watchedAt * 1000),
            lastEventAt: row.lastEventAt != null ? new Date(row.lastEventAt * 1000) : null,
            lastEventType: row.lastEventType as FileEventType | null,
        }));
    }

    // Watchers on the root paths and on every ancestor of each root (one inclusive
    // upward CTE seeded with all roots), deduped, with the acting user removed.
    collectWatcherIds(rootPathIds: string[], excludeUserId: string): string[] {
        const rootList = sql.join(
            rootPathIds.map((id) => sql`${id}`),
            sql`, `,
        );
        const rows = this.db.all<{ userId: string }>(sql`
            WITH RECURSIVE chain(id) AS (
                SELECT id FROM ${paths} WHERE id IN (${rootList})
                UNION
                SELECT p.${sql.raw('parentId')} FROM ${paths} p JOIN chain c ON p.id = c.id
                WHERE p.${sql.raw('parentId')} IS NOT NULL
            )
            SELECT DISTINCT pw.userId AS userId FROM ${pathWatchers} pw JOIN chain ON pw.pathId = chain.id
            WHERE pw.userId != ${excludeUserId}
        `);
        return rows.map((row) => row.userId);
    }

    // Per-watcher delivery with ACL re-verification: a watcher whose share was
    // revoked since watching is silently skipped. verifyAncestors is the chain
    // that justifies the notification — callers capture it BEFORE mutations that
    // rewrite the parent chain (trash re-parents to the mount root).
    async notifyWatchers(
        watcherIds: string[],
        opts: {
            eventType: FileEventType;
            actor: User;
            itemName: string;
            tagPathId: string; // the path the tag points at (parent for burst events)
            verifyAncestors: DrivePath[];
            excludeEmails?: Set<string>;
        },
    ): Promise<void> {
        // Per-watcher lookups run concurrently — a shared folder with many watchers
        // would otherwise add serial auth-db round-trips to every mutation request.
        await Promise.all(
            watcherIds.map(async (watcherId) => {
                const watcher = await getUserById(watcherId);
                if (!watcher) return;
                if (opts.excludeEmails?.has(watcher.email.toLowerCase())) return;
                const memberships = await getMemberships(watcherId);
                if (!canReadFromAncestors(opts.verifyAncestors, watcher, memberships)) return;
                await sendToHome(watcherId, {
                    type: 'notification',
                    notification: {
                        type: 'file-event',
                        actorEmail: opts.actor.email,
                        title: `${opts.actor.name} ${fileEventVerb(opts.eventType)} ${stripEigenExtension(opts.itemName)}`,
                        tag: `file-event:${this.ownerId}:${this.mountId}:${opts.tagPathId}`,
                        coalesce: true,
                    },
                }).catch(() => {});
            }),
        );
    }

    async fanOut(opts: {
        eventType: FileEventType;
        actor: User;
        path: DrivePath; // affected item (pre-mutation shape where relevant)
        chainRootIds: (string | null)[]; // parent chains to walk (e.g. [parentId]; moved: both)
        burst?: boolean; // created/uploaded/copied: tag on the parent folder
        excludeEmails?: Set<string>;
        // Thunks resolve only when there are watchers — zero watchers (the common
        // case) costs zero breadcrumb walks. Mutations that rewrite the parent
        // chain (trash/move) pass pre-captured arrays instead.
        verifyAncestors: DrivePath[] | (() => Promise<DrivePath[]>);
    }): Promise<void> {
        // Events on items already in trash never fan out ('trashed' itself passes
        // the pre-trash snapshot, whose trashedAt is still null).
        if (opts.path.trashedAt && opts.eventType !== 'trashed') return;
        if (this.isContainerInternal(opts.path.id)) return;
        const chainRoots = opts.chainRootIds.filter((id): id is string => id !== null);
        const watcherIds = this.collectWatcherIds([opts.path.id, ...chainRoots], opts.actor.id);
        if (watcherIds.length === 0) return;
        await this.notifyWatchers(watcherIds, {
            eventType: opts.eventType,
            actor: opts.actor,
            itemName: opts.path.name,
            tagPathId: opts.burst ? (chainRoots[0] ?? opts.path.id) : opts.path.id,
            verifyAncestors:
                typeof opts.verifyAncestors === 'function' ? await opts.verifyAncestors() : opts.verifyAncestors,
            excludeEmails: opts.excludeEmails,
        });
    }

    // Synchronous; called fire-and-forget from Mount.init.
    prune(): void {
        // Drop rows older than 90 days
        this.db.run(sql`
            DELETE FROM ${fileEvents}
            WHERE createdAt < unixepoch() - ${HISTORY_MAX_AGE_DAYS * 24 * 3600}
        `);
        // Trim rows beyond 500 per path (keep the newest ones)
        this.db.run(sql`
            DELETE FROM ${fileEvents} WHERE id IN (
                SELECT id FROM (
                    SELECT id, ROW_NUMBER() OVER (PARTITION BY pathId ORDER BY createdAt DESC) AS rn
                    FROM ${fileEvents}
                ) WHERE rn > ${HISTORY_MAX_PER_PATH}
            )
        `);
    }
}
