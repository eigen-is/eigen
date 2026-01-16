import type {User} from 'better-auth/types';
import type Database from 'bun:sqlite';
import type {ServerWebSocket} from 'bun';

export interface HomeInterface {
    user: User;
    homeDir: string;
    
    getDatabase(relativePath: string, onCreate: (db: Database) => Promise<void>): Promise<Database>;
    openSQLiteDatabase(relativePath: string, onCreate: (db: Database) => Promise<void>): Promise<Database>;
    closeSQLiteDatabase(db: Database): Promise<void>;
    
    subscribe(ws: ServerWebSocket): void;
    unsubscribe(ws: ServerWebSocket): void;
    notify(event: any): void;
}
