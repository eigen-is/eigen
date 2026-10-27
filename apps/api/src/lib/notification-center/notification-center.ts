// The notifications of a user's Home, kept in their own SQLite database. Other code adds one, such as an access
// request or a calendar invitation, and the user lists, reads and removes them in the app. A repeat with the same
// tag can replace the older notification within a short time, instead of piling up.

import { randomUUID } from 'node:crypto';
import type { Notification, NotificationPersistInput } from '@workspace/lib/types/notification';
import { and, desc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { PATHS } from '../config/paths';
import type { ManagedDatabase } from '../core';
import type { Home } from '../home';
import { NOTIFICATION_CENTER_DB_CONFIG } from './db-config';
import * as schema from './schema';
import { buildNotificationChangedEvent, buildNotificationCreatedEvent } from './sse-events';

const COALESCE_WINDOW_MS = 30_000;

function toNotification(row: typeof schema.notifications.$inferSelect): Notification {
    return {
        id: row.id,
        type: row.type,
        actorEmail: row.actorEmail,
        title: row.title,
        body: row.body,
        tag: row.tag,
        read: row.read,
        createdAt: row.createdAt,
        details: row.details,
    };
}

export class NotificationCenter {
    private managedDb!: ManagedDatabase<typeof schema>;
    private db!: BunSQLiteDatabase<typeof schema>;
    private home: Home;

    public constructor(home: Home) {
        this.home = home;
    }

    public async init(): Promise<void> {
        this.managedDb = await this.home.getLocalDatabase(NOTIFICATION_CENTER_DB_CONFIG, PATHS.NOTIFICATIONS.DB);
        this.db = this.managedDb.db;
    }

    public async destruct(): Promise<void> {
        if (this.managedDb) {
            await this.managedDb.close();
        }
    }

    public persist(input: NotificationPersistInput): Notification {
        const id = randomUUID();
        const now = new Date();
        // Select BEFORE the upsert — afterwards the row always exists with createdAt = now.
        const prior =
            input.coalesce && input.tag
                ? this.db.select().from(schema.notifications).where(eq(schema.notifications.tag, input.tag)).get()
                : undefined;
        const row = {
            id,
            type: input.type,
            actorEmail: input.actorEmail ?? null,
            title: input.title,
            body: input.body ?? null,
            tag: input.tag ?? null,
            read: false,
            createdAt: now,
            details: input.details ?? null,
        };

        this.db
            .insert(schema.notifications)
            .values(row)
            .onConflictDoUpdate({
                target: schema.notifications.tag,
                set: {
                    type: row.type,
                    actorEmail: row.actorEmail,
                    title: row.title,
                    body: row.body,
                    read: false,
                    createdAt: now,
                    details: row.details,
                },
            })
            .run();

        if (!prior || now.getTime() - prior.createdAt.getTime() >= COALESCE_WINDOW_MS) {
            this.home.broadcast(buildNotificationCreatedEvent(input.title, input.body, input.type, input.tag));
        }
        return row;
    }

    // The first page also holds every unread row, however old, so chat's unread dots can read this one list.
    public list(limit: number = 50, before?: Date): Notification[] {
        const { notifications } = schema;
        const newestFirst = desc(notifications.createdAt);
        const query = this.db.select().from(notifications).orderBy(newestFirst).$dynamic();
        if (before) return query.where(lt(notifications.createdAt, before)).limit(limit).all().map(toNotification);

        const newest = this.db.select({ id: notifications.id }).from(notifications).orderBy(newestFirst).limit(limit);
        return query
            .where(or(eq(notifications.read, false), inArray(notifications.id, newest)))
            .all()
            .map(toNotification);
    }

    public unreadCount(): number {
        const result = this.db
            .select({ count: sql<number>`count(*)` })
            .from(schema.notifications)
            .where(eq(schema.notifications.read, false))
            .get();
        return result?.count ?? 0;
    }

    public markRead(id: string): void {
        this.db.update(schema.notifications).set({ read: true }).where(eq(schema.notifications.id, id)).run();
        this.home.broadcast(buildNotificationChangedEvent());
    }

    public markReadByTag(tag: string): void {
        const marked = this.db
            .update(schema.notifications)
            .set({ read: true })
            .where(and(eq(schema.notifications.tag, tag), eq(schema.notifications.read, false)))
            .returning({ id: schema.notifications.id })
            .all();
        if (marked.length > 0) this.home.broadcast(buildNotificationChangedEvent());
    }

    public markAllRead(): void {
        this.db.update(schema.notifications).set({ read: true }).where(eq(schema.notifications.read, false)).run();
        this.home.broadcast(buildNotificationChangedEvent());
    }

    public dismiss(id: string): void {
        this.db.delete(schema.notifications).where(eq(schema.notifications.id, id)).run();
        this.home.broadcast(buildNotificationChangedEvent());
    }
}
