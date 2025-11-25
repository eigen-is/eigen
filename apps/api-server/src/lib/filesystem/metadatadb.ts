import type Database from "bun:sqlite";
import EigenDatabase from "./database";
import { drivePaths, driveLabels, drivePathsToLabels } from "./metadatadbschema";
import { eq, isNull } from "drizzle-orm";
import { randomUUID } from "crypto";
import type { DrivePath } from "../../types/drive";

// Define the schema type with all related tables
type DriveSchema = {
  drivePaths: typeof drivePaths;
  driveLabels: typeof driveLabels;
  drivePathsToLabels: typeof drivePathsToLabels;
};

export default class MetadataDb extends EigenDatabase<DriveSchema> {
    public async init() {
        return super.init({drivePaths, driveLabels, drivePathsToLabels}, async (db: Database) => {
            // Execute migration SQL to create tables
            db.exec(`
                -- Create drive_paths table
                CREATE TABLE IF NOT EXISTS drive_paths (
                  id TEXT PRIMARY KEY,
                  name TEXT NOT NULL,
                  type TEXT NOT NULL,
                  parentId TEXT,
                  size INTEGER DEFAULT 0,
                  thumbnail TEXT,
                  ownerId TEXT NOT NULL,
                  mimeType TEXT NOT NULL,
                  acl TEXT,
                  createdAt INTEGER DEFAULT (unixepoch()),
                  updatedAt INTEGER DEFAULT (unixepoch()),
                  FOREIGN KEY (parentId) REFERENCES drive_paths(id) ON DELETE CASCADE
                );
      
                -- Create drive_labels table
                CREATE TABLE IF NOT EXISTS drive_labels (
                  id TEXT PRIMARY KEY,
                  name TEXT NOT NULL,
                  color TEXT NOT NULL,
                  createdAt INTEGER DEFAULT (unixepoch()),
                  updatedAt INTEGER DEFAULT (unixepoch())
                );
      
                -- Create junction table for drive_paths and labels
                CREATE TABLE IF NOT EXISTS drive_paths_to_labels (
                  drivePathId TEXT NOT NULL,
                  labelId TEXT NOT NULL,
                  PRIMARY KEY (drivePathId, labelId),
                  FOREIGN KEY (drivePathId) REFERENCES drive_paths(id) ON DELETE CASCADE,
                  FOREIGN KEY (labelId) REFERENCES drive_labels(id) ON DELETE CASCADE
                );
                
                -- Create indexes for faster queries
                CREATE INDEX IF NOT EXISTS idx_drive_paths_parentId ON drive_paths(parentId);
                CREATE INDEX IF NOT EXISTS idx_drive_paths_ownerId ON drive_paths(ownerId);
                CREATE INDEX IF NOT EXISTS idx_drive_paths_to_labels_drivePathId ON drive_paths_to_labels(drivePathId);
                CREATE INDEX IF NOT EXISTS idx_drive_paths_to_labels_labelId ON drive_paths_to_labels(labelId);
              `);
        });
    }

    /**
     * Insert an item into the metadata database
     */
    public async insertItem(params: Partial<DrivePath> & { ownerId: string, name: string, mimeType: string }): Promise<string> {
        const id = params.id ?? randomUUID();
        
        // Explicitly create an object that exactly matches the schema
        await this.db.insert(drivePaths).values({
            id,
            name: params.name,
            type: params.type ?? "file",
            parentId: params.parentId ?? null,
            ownerId: params.ownerId,
            mimeType: params.mimeType,
            size: params.size ?? 0,
            thumbnail: params.thumbnail ?? null,
            acl: params.acl ?? null,
            createdAt: new Date(),
            updatedAt: new Date()
        });

        return id;
    }

    /**
     * Get a path by ID
     */
    public async getPath(pathId: string) {
        return await this.db.query.drivePaths.findFirst({
            where: (drivePaths, { eq }) => eq(drivePaths.id, pathId)
        });
    }

    /**
     * Get paths by parent ID
     */
    public async getPathsByParent(parentId?: string) {
        // If parentId is undefined or null, get root items
        if (!parentId) {
            return await this.db.select().from(drivePaths).where(isNull(drivePaths.parentId));
        }
        
        // Otherwise get children of specified parent
        return await this.db.select().from(drivePaths).where(eq(drivePaths.parentId, parentId));
    }

    /**
     * Update a path's name
     */
    public async updateName(pathId: string, newName: string): Promise<void> {
        await this.db.update(drivePaths)
            .set({
                name: newName,
                updatedAt: new Date()
            })
            .where(eq(drivePaths.id, pathId));
    }

    /**
     * Move a path to a new parent
     */
    public async updateParent(pathId: string, newParentId: string | null): Promise<void> {
        await this.db.update(drivePaths)
            .set({
                parentId: newParentId,
                updatedAt: new Date()
            })
            .where(eq(drivePaths.id, pathId));
    }

    /**
     * Update a path's ACL permissions
     */
    public async setACL(pathId: string, acl: any[] | null): Promise<void> {
        await this.db.update(drivePaths)
            .set({
                acl,
                updatedAt: new Date()
            })
            .where(eq(drivePaths.id, pathId));
    }

    /**
     * Update a path's thumbnail
     */
    public async updateThumbnail(pathId: string, thumbnail: string | null): Promise<void> {
        await this.db.update(drivePaths)
            .set({
                thumbnail,
                updatedAt: new Date()
            })
            .where(eq(drivePaths.id, pathId));
    }

    /**
     * Update a path's size
     */
    public async updateSize(pathId: string, size: number): Promise<void> {
        await this.db.update(drivePaths)
            .set({
                size,
                updatedAt: new Date()
            })
            .where(eq(drivePaths.id, pathId));
    }

    /**
     * Delete a path and its children recursively
     */
    public async deletePath(pathId: string): Promise<void> {
        // Due to cascading deletes in the schema, this will delete all children too
        await this.db.delete(drivePaths)
            .where(eq(drivePaths.id, pathId));
    }

    /**
     * Resolve full path by walking up the parent chain
     * Returns path like "/folder1/subfolder2/file.txt"
     */
    public async resolveFullPath(pathId: string): Promise<string | null> {
        const pathSegments: string[] = [];
        let currentId: string | null = pathId;

        while (currentId) {
            const item = await this.getPath(currentId);
            if (!item) {
                return null;
            }
            
            pathSegments.unshift(item.name);
            currentId = item.parentId;
        }

        return '/' + pathSegments.join('/');
    }
}
