import { randomUUID } from 'node:crypto';
import type { FileEvent, FileEventInput, FileEventType } from '@workspace/lib/types/file-history';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import type * as schema from '../mount/schema';
import { fileEvents, paths } from '../mount/schema';

const HISTORY_MAX_AGE_DAYS = 90;
const HISTORY_MAX_PER_PATH = 500;

export class FileHistory {
    constructor(
        private db: BunSQLiteDatabase<typeof schema>,
        readonly ownerId: string,
        readonly mountId: string,
    ) {}

    async record(input: FileEventInput, opts?: { dedupeWindowMs?: number }): Promise<void> {
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
    async list(pathId: string, opts?: { limit?: number; before?: Date }): Promise<FileEvent[]> {
        const limit = opts?.limit ?? 50;

        // Build the before clause conditionally — drizzle sql template uses ${} interpolation
        const beforeClause =
            opts?.before != null ? sql`AND e.createdAt < ${Math.floor(opts.before.getTime() / 1000)}` : sql``;

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
            WHERE 1=1 ${beforeClause}
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
