import type { Notification } from '@workspace/lib/types/notification';
import { desc, eq, sql } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { v4 as uuidv4 } from 'uuid';
import type { ManagedDatabase } from '../core';
import type { Home } from '../home';
import { NOTIFICATION_CENTER_DB_CONFIG } from './db-config';
import * as schema from './schema';
import { buildNotificationCreatedEvent } from './sse-events';

type PersistInput = {
    type: string;
    actorEmail?: string | null;
    title: string;
    body?: string | null;
    tag?: string | null;
};

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
    };
}

export class NotificationCenter {
    private managedDb!: ManagedDatabase<typeof schema>;
    private db!: BunSQLiteDatabase<typeof schema>;
    private home: Home;

    constructor(home: Home) {
        this.home = home;
    }

    async init(): Promise<void> {
        this.managedDb = await this.home.getLocalDatabase(
            NOTIFICATION_CENTER_DB_CONFIG,
            'eigen.notifications/notifications.db',
        );
        this.db = this.managedDb.db;
    }

    async destruct(): Promise<void> {
        if (this.managedDb) {
            await this.managedDb.close();
        }
    }

    persist(input: PersistInput): Notification {
        const id = uuidv4();
        const now = new Date();
        const row = {
            id,
            type: input.type,
            actorEmail: input.actorEmail ?? null,
            title: input.title,
            body: input.body ?? null,
            tag: input.tag ?? null,
            read: false,
            createdAt: now,
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
                },
            })
            .run();

        this.home.broadcast(buildNotificationCreatedEvent(input.title, input.body));
        return row;
    }

    list(limit: number = 50, before?: Date): Notification[] {
        let query = this.db.select().from(schema.notifications);

        if (before) {
            query = query.where(sql`${schema.notifications.createdAt}
            <
            ${Math.floor(before.getTime() / 1000)}`) as typeof query;
        }

        const rows = query.orderBy(desc(schema.notifications.createdAt)).limit(limit).all();

        return rows.map(toNotification);
    }

    unreadCount(): number {
        const result = this.db
            .select({ count: sql<number>`count(*)` })
            .from(schema.notifications)
            .where(eq(schema.notifications.read, false))
            .get();
        return result?.count ?? 0;
    }

    markRead(id: string): void {
        this.db.update(schema.notifications).set({ read: true }).where(eq(schema.notifications.id, id)).run();
    }

    markAllRead(): void {
        this.db.update(schema.notifications).set({ read: true }).where(eq(schema.notifications.read, false)).run();
    }

    dismiss(id: string): void {
        this.db.delete(schema.notifications).where(eq(schema.notifications.id, id)).run();
    }
}
