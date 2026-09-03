import { randomUUID } from 'node:crypto';
import { type DrivePath, type DrivePathType, isDocumentType } from '@workspace/lib/types/drive';
import {
    describeFileEvent,
    type FileEvent,
    type FileEventInput,
    type FileEventType,
    type PathWatchStatus,
    toFileEventType,
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

    // Entities inside an eigendoc/chat container (per-card comment threads, attachment media)
    // are scaffolding, never timeline rows — the container speaks through its own events.
    private isContainerInternal(pathId: string): boolean {
        const ancestors = this.db.all<{ type: DrivePathType }>(sql`
            WITH RECURSIVE chain(id) AS (
                SELECT ${sql.raw('parentId')} FROM ${paths} WHERE id = ${pathId} AND ${sql.raw('parentId')} IS NOT NULL
                UNION
                SELECT p.${sql.raw('parentId')} FROM ${paths} p JOIN chain c ON p.id = c.id
                WHERE p.${sql.raw('parentId')} IS NOT NULL
            )
            SELECT p.type AS type FROM ${paths} p JOIN chain c ON p.id = c.id
        `);
        return ancestors.some((a) => isDocumentType(a.type));
    }

    record(input: FileEventInput, opts?: { dedupeWindowMs?: number }): void {
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
    list(pathId: string, opts?: { limit?: number }): FileEvent[] {
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
            pathType: DrivePathType;
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
            eventType: toFileEventType(row.eventType),
            actorUserId: row.actorUserId,
            actorEmail: row.actorEmail,
            details: row.details != null ? JSON.parse(row.details) : null,
            createdAt: new Date(row.createdAt * 1000),
            pathName: row.pathName,
            pathType: row.pathType,
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

    listWatchedPathIds(userId: string): string[] {
        return this.db
            .select({ pathId: pathWatchers.pathId })
            .from(pathWatchers)
            .where(eq(pathWatchers.userId, userId))
            .all()
            .map((r) => r.pathId);
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
            pathType: DrivePathType;
            details?: FileEvent['details'];
            tagPathId: string; // the path the tag points at (parent for burst events)
            verifyAncestors: DrivePath[];
            excludeEmails?: Set<string>;
        },
    ): Promise<void> {
        // Compose the row once through the shared phrasing layer (the same the activity panel
        // renders with): title = actor + action, body = primary content, details = link/secondary.
        const lines = describeFileEvent(
            {
                eventType: opts.eventType,
                details: opts.details ?? null,
                pathName: opts.itemName,
                pathType: opts.pathType,
            },
            'container',
        );
        const d = opts.details;
        const cardId = d && 'cardId' in d ? d.cardId : undefined;
        const chatName = d && 'chatName' in d ? d.chatName : undefined;
        // Concurrent + per-watcher isolated: delivery runs after the mutation committed, so one
        // watcher's auth-db hiccup must neither reject the fan-out nor drop the other watchers.
        await Promise.all(
            watcherIds.map(async (watcherId) => {
                try {
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
                            title: `${opts.actor.name} ${lines.action}`,
                            body: lines.primary,
                            tag: `file-event:${this.ownerId}:${this.mountId}:${opts.tagPathId}`,
                            coalesce: true,
                            details: { secondary: lines.secondary, cardId, chatName, pathType: opts.pathType },
                        },
                    });
                } catch {
                    // best-effort delivery — never surface to the triggering mutation
                }
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
        details?: FileEvent['details']; // event details → notification body/secondary/links
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
            pathType: opts.path.type,
            details: opts.details,
            tagPathId: opts.burst ? (chainRoots[0] ?? opts.path.id) : opts.path.id,
            verifyAncestors:
                typeof opts.verifyAncestors === 'function' ? await opts.verifyAncestors() : opts.verifyAncestors,
            excludeEmails: opts.excludeEmails,
        });
    }

    prune(): void {
        this.db.run(sql`
            DELETE FROM ${fileEvents}
            WHERE createdAt < unixepoch() - ${HISTORY_MAX_AGE_DAYS * 24 * 3600}
        `);
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
