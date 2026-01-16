import type {User} from 'better-auth/types';
import type Database from 'bun:sqlite';
import type {EigenNotification} from './notification';

export interface HomeInterface {
    user: User;
    homeDir: string;
    
    getDatabase(relativePath: string, onCreate: (db: Database) => Promise<void>): Promise<Database>;
    openSQLiteDatabase(relativePath: string, onCreate: (db: Database) => Promise<void>): Promise<Database>;
    closeSQLiteDatabase(db: Database): Promise<void>;
    
    subscribeSSE(listener: (event: EigenNotification) => void): void;
    unsubscribeSSE(listener: (event: EigenNotification) => void): void;
    notify(event: EigenNotification): void;
}
