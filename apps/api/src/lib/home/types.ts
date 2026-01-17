import type {User} from 'better-auth/types';
import type Database from 'bun:sqlite';
import type {SSEEvent} from '@workspace/lib/types/sse';

export interface HomeInterface {
    user: User;
    homeDir: string;
    
    getDatabase(relativePath: string, onCreate: (db: Database) => Promise<void>): Promise<Database>;
    openSQLiteDatabase(relativePath: string, onCreate: (db: Database) => Promise<void>): Promise<Database>;
    closeSQLiteDatabase(db: Database): Promise<void>;
    
    subscribeSSE(listener: (event: SSEEvent) => void): void;
    unsubscribeSSE(listener: (event: SSEEvent) => void): void;
    notify(event: SSEEvent): void;
}
