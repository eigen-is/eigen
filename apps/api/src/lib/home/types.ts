import type {User} from 'better-auth/types';
import type Database from 'bun:sqlite';
import type {SSEvent} from '@workspace/lib/types/sse';

export interface HomeInterface {
    user: User;
    homeDir: string;

    getDatabase(relativePath: string, onCreate: (db: Database) => Promise<void>): Promise<Database>;

    openSQLiteDatabase(relativePath: string, onCreate: (db: Database) => Promise<void>): Promise<Database>;

    closeSQLiteDatabase(db: Database): Promise<void>;

    subscribeSSE(listener: (event: SSEvent) => void): void;

    unsubscribeSSE(listener: (event: SSEvent) => void): void;

    notify(event: SSEvent): void;
}
