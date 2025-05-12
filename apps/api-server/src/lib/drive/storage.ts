import { S3Client, type BunFile, type S3File } from 'bun';
import { join } from 'node:path';
import { mkdir, rm, exists } from 'node:fs/promises';
import { tmpdir } from 'node:os';

export class S3Storage {
  private client: S3Client;
  private userId: string;
  private tempDir: string;


  constructor(userId: string, config: {
    endpoint: string;
    region?: string;
    accessKeyId: string;
    secretAccessKey: string;
    bucketName: string;
    tempDir?: string;
  }) {
    this.userId = userId;
    

    this.client = new S3Client({
      endpoint: config.endpoint,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey
    });
    

    this.tempDir = config.tempDir || join(tmpdir(), 'eigen-files', userId);
  }


  private generateKey(pathId: string): string {
    return `${pathId}.${this.userId}`;
  }


  async uploadFile(pathId: string, data: Buffer | Uint8Array | BunFile): Promise<void> {
    const key = this.generateKey(pathId);
    
    try {
      await this.client.write(key, data);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to upload file ${pathId}: ${errorMessage}`);
    }
  }

  public getFile(pathId: string): S3File {
    const key = this.generateKey(pathId);
    
    try {
      return this.client.file(key);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to download file ${pathId}: ${errorMessage}`);
    }
  }

  public async deleteFile(pathId: string): Promise<void> {
    const key = this.generateKey(pathId);
    
    try {
        await this.client.delete(key);
    } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to delete file ${pathId}: ${errorMessage}`);
    }
  }

  public async fileExists(pathId: string): Promise<boolean> {
    const key = this.generateKey(pathId);
    
    try {
      return await this.client.exists(key);
    } catch {
      return false;
    }
  }

  public async downloadToTemp(pathId: string): Promise<string> {
    await mkdir(this.tempDir, { recursive: true });    

    const tempFilename = pathId.replace(/\//g, '_');
    const tempFilePath = join(this.tempDir, tempFilename);
    
    try {
      await Bun.write(tempFilePath, this.getFile(pathId));
      return tempFilePath;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to download file ${pathId} to temp: ${errorMessage}`);
    }
  }

  async uploadFromTemp(tempFilePath: string, pathId: string): Promise<void> {
    try {
      await this.uploadFile(pathId, Bun.file(tempFilePath));
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to upload file from temp ${tempFilePath} as ${pathId}: ${errorMessage}`);
    }
  }


  async cleanupTemp(): Promise<void> {
    try {
      if (await exists(this.tempDir)) {
        await rm(this.tempDir, { recursive: true, force: true });
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`Failed to clean up temporary directory: ${errorMessage}`);

    }
  }
}


// async function workWithDatabase(s3Storage: S3Storage, dbPathId: string) {
//     // Download the database to temporary storage
//     const tempDbPath = await s3Storage.downloadToTemp(dbPathId);
    
//     try {
//       // Open the database with Bun's SQLite
//       const db = new Bun.Database(tempDbPath);
      
//       // Work with the database
//       const query = db.query("SELECT * FROM your_table");
//       const results = query.all();
      
//       // Make changes
//       db.exec("UPDATE your_table SET column = value WHERE condition");
//       db.exec("INSERT INTO your_table VALUES (...)");
      
//       // Database is automatically saved to the temporary file
//       // Close the database explicitly to ensure all changes are written
//       db.close();
      
//       // Upload the modified database back to S3
//       await s3Storage.uploadFromTemp(tempDbPath, dbPathId);
//     } finally {
//       // Clean up temporary files
//       await s3Storage.cleanupTemp();
//     }
//   }