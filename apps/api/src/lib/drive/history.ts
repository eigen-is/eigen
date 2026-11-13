// The file history of one mount: a row for each change to a path, such as an upload, a rename or a
// share, and the users who watch a path. After a change, the watchers of the path and of the folders
// above it get a notification. Each Mount builds one, and Drive records changes through it.

import { fileEventTag } from '@workspace/lib/notification/tags';
import type { DrivePath, DrivePathType } from '@workspace/lib/types/drive';
import { isDocumentType } from '@workspace/lib/types/drive';
import type { FileEvent, FileEventInput, FileEventType, PathWatchStatus } from '@workspace/lib/types/file-history';
import { aclPrincipalsToResolve, describeFileEvent, toFileEventType } from '@workspace/lib/types/file-history';
import type { SQL } from 'drizzle-orm';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { sendToUserHomes } from '../home/home-relay';
import type * as schema from '../mount/schema';
import { fileEvents, paths, pathWatchers } from '../mount/schema';
import { getBatchPublicInfo } from '../space/public';
import type { User } from '../user';
import { getMemberships, getUserById } from '../user';
import { canReadFromAncestors } from './acl';

// Caps per path and none on age, so a quiet file keeps its whole story. Each recorded event trims its
// path, edits first, so a busy document keeps its other rows.
const HISTORY_MAX_EDITED_PER_PATH = 100;
const HISTORY_MAX_PER_PATH = 500;

export class FileHistory {
    public constructor(
        private readonly db: BunSQLiteDatabase<typeof schema>,
        public readonly ownerId: string,
        public readonly mountId: string,
    ) {}

    public record(input: FileEventInput, opts?: { dedupeWindowMs?: number }): void {
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
                id: crypto.randomUUID(),
                pathId: input.pathId,
                eventType: input.eventType,
                actorUserId: input.actor.id,
                actorEmail: input.actor.email,
                details: input.details ?? null,
                createdAt: new Date(),
            })
            .run();
        this.keepNewest(input.pathId, HISTORY_MAX_EDITED_PER_PATH, sql`AND eventType = 'edited'`);
        this.keepNewest(input.pathId, HISTORY_MAX_PER_PATH, sql``);
    }

    // A file's own events; a folder's or a document's also those of everything below it. Newest first.
    public list(pathId: string, opts?: { limit?: number }): FileEvent[] {
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
            ORDER BY e.createdAt DESC, e.rowid DESC
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

    public addWatcher(pathId: string, userId: string): void {
        this.db.insert(pathWatchers).values({ pathId, userId, createdAt: new Date() }).onConflictDoNothing().run();
    }

    public removeWatcher(pathId: string, userId: string): void {
        this.db
            .delete(pathWatchers)
            .where(and(eq(pathWatchers.pathId, pathId), eq(pathWatchers.userId, userId)))
            .run();
    }

    public getWatchStatus(pathId: string, userId: string): PathWatchStatus {
        const direct = this.db
            .select({ pathId: pathWatchers.pathId })
            .from(pathWatchers)
            .where(and(eq(pathWatchers.pathId, pathId), eq(pathWatchers.userId, userId)))
            .get();

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
            ...(ancestor ? { viaAncestor: ancestor } : {}),
        };
    }

    public listWatchedPathIds(userId: string): string[] {
        return this.db
            .select({ pathId: pathWatchers.pathId })
            .from(pathWatchers)
            .where(eq(pathWatchers.userId, userId))
            .all()
            .map((row) => row.pathId);
    }

    // The watchers of the roots and of every folder above them, without the actor.
    public collectWatcherIds(rootPathIds: readonly string[], excludeUserId: string): string[] {
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

    // A watcher whose share was revoked since watching is skipped. verifyAncestors is the chain that justifies the
    // notification, captured before a change that rewrites it, as a trash moves the item to the mount root.
    public async notifyWatchers(
        watcherIds: readonly string[],
        opts: {
            eventType: FileEventType;
            actor: User;
            itemName: string;
            pathType: DrivePathType;
            details?: FileEvent['details'];
            tagPathId: string;
            verifyAncestors: readonly DrivePath[];
            excludeEmails?: ReadonlySet<string>;
        },
    ): Promise<void> {
        const { details } = opts;
        // The stored body names teams, so their names are resolved now and not when it renders. The change has landed
        // by now, so a notification that can't be written is logged and never fails the change.
        const names = await getBatchPublicInfo(aclPrincipalsToResolve(details)).catch((error: unknown) => {
            console.error(`[FileHistory] Failed to notify the watchers of ${opts.tagPathId}:`, error);
            return null;
        });
        if (!names) return;
        const lines = describeFileEvent(
            {
                eventType: opts.eventType,
                details: details ?? null,
                pathName: opts.itemName,
                pathType: opts.pathType,
            },
            'container',
            { resolveName: (id) => names[id]?.name },
        );
        const cardId = details && 'cardId' in details ? details.cardId : undefined;
        const chatName = details && 'chatName' in details ? details.chatName : undefined;
        // One failed lookup skips only that watcher, because the change has landed already.
        const recipients = await Promise.all(
            watcherIds.map(async (watcherId) => {
                try {
                    const watcher = await getUserById(watcherId);
                    if (!watcher) return null;
                    if (opts.excludeEmails?.has(watcher.email.toLowerCase())) return null;
                    const memberships = await getMemberships(watcherId);
                    return canReadFromAncestors(opts.verifyAncestors, watcher, memberships) ? watcherId : null;
                } catch {
                    return null;
                }
            }),
        );
        // The deliveries open each watcher's home, so they run after the change answers.
        sendToUserHomes(
            recipients.filter((id) => id !== null),
            {
                type: 'notification',
                notification: {
                    type: 'file-event',
                    actorEmail: opts.actor.email,
                    title: `${opts.actor.name} ${lines.action}`,
                    body: lines.primary,
                    tag: fileEventTag({ ownerId: this.ownerId, mountId: this.mountId, pathId: opts.tagPathId }),
                    coalesce: true,
                    details: { secondary: lines.secondary, cardId, chatName, pathType: opts.pathType },
                },
            },
        );
    }

    public async fanOut(opts: {
        eventType: FileEventType;
        actor: User;
        path: DrivePath;
        // The folders whose chains are walked, such as both of a move's parents.
        chainRootIds: readonly (string | null)[];
        // A burst, such as an upload, is tagged with its folder, so many uploads fold into one row.
        burst?: boolean;
        excludeEmails?: ReadonlySet<string>;
        details?: FileEvent['details'];
        // A function runs only when there are watchers, which is rare, so most changes walk no breadcrumbs. A change
        // that rewrites the parent chain, such as a trash or a move, passes the chain it captured before.
        verifyAncestors: readonly DrivePath[] | (() => Promise<readonly DrivePath[]>);
    }): Promise<void> {
        // An item already in trash never fans out. The 'trashed' event passes the item as it was before.
        if (opts.path.trashedAt && opts.eventType !== 'trashed') return;
        if (this.isContainerInternal(opts.path.id)) return;
        const chainRoots = opts.chainRootIds.filter((id) => id !== null);
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

    private keepNewest(pathId: string, keep: number, only: SQL): void {
        this.db.run(sql`
            DELETE FROM ${fileEvents} WHERE id IN (
                SELECT id FROM ${fileEvents} WHERE pathId = ${pathId} ${only}
                ORDER BY createdAt DESC, rowid DESC LIMIT -1 OFFSET ${keep}
            )
        `);
    }

    // What sits inside a document, such as a card's comment thread or its media, gets no timeline rows.
    // The document speaks through its own events.
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
        return ancestors.some((ancestor) => isDocumentType(ancestor.type));
    }
}
