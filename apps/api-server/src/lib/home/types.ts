import type {User} from 'better-auth/types';
import type Database from 'bun:sqlite';

export interface HomeInterface {
    user: User;
    homeDir: string;
    
    getDatabase(relativePath: string, onCreate: (db: Database) => Promise<void>): Promise<Database>;
    openSQLiteDatabase(relativePath: string, onCreate: (db: Database) => Promise<void>): Promise<Database>;
    closeSQLiteDatabase(db: Database): Promise<void>;
    
    subscribeSSE(listener: (event: any) => void): void;
    unsubscribeSSE(listener: (event: any) => void): void;
    notify(event: any): void;
}
