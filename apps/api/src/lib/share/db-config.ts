import type {DatabaseConfig} from '../core/managed-database';
import * as schema from './schema';

export const SHARE_REGISTRY_DB_CONFIG: DatabaseConfig<typeof schema> = {
    name: 'share-registry',
    currentVersion: 1,
    schema,
    migrations: [
        {
            version: 1,
            up: (db) =>
                db.exec(`
                CREATE TABLE IF NOT EXISTS share_registry
                (
                    fromUserId
                    TEXT
                    NOT
                    NULL,
                    targetIdentifier
                    TEXT
                    NOT
                    NULL,
                    PRIMARY
                    KEY
                (
                    fromUserId,
                    targetIdentifier
                )
                    );

                CREATE INDEX IF NOT EXISTS idx_share_registry_target
                    ON share_registry(targetIdentifier);
            `),
        },
    ],
};
