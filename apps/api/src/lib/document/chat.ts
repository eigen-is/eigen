import type { DrivePath } from '@workspace/lib/types/drive';
import { desc, isNull } from 'drizzle-orm';
import { CHAT_ROOM_DB_CONFIG } from '../chat/db-config';
import { messages } from '../chat/schema';
import type { Mount } from '../mount';

// Drive-wide view of a chat: the NEWEST messages up to capBytes (most relevant for
// "find the chat that mentioned X"). Reads the tail cheaply via idx_messages_createdAt;
// no full scan, no Yjs (chat's data.db is a relational ManagedDatabase).
export async function readChatContent(mount: Mount, drivePath: DrivePath, capBytes: number): Promise<string> {
    const dataDbPath = await mount.getChildByName(drivePath.id, 'data.db');
    if (!dataDbPath) return '';

    const managedDb = await mount.openDatabase(CHAT_ROOM_DB_CONFIG, dataDbPath.id);
    const rows = managedDb.db
        .select({ content: messages.content, authorEmail: messages.authorEmail })
        .from(messages)
        .where(isNull(messages.deletedAt))
        .orderBy(desc(messages.createdAt))
        // Bound memory on long chats. The loop below stops once `out` exceeds capBytes, and
        // every message contributes at least one char to `out`, so we never consume more than
        // capBytes of the newest messages — fetching at most that many leaves the result
        // identical while capping how many rows we materialise.
        .limit(capBytes)
        .all();

    let out = '';
    for (const row of rows) {
        const piece = `${row.authorEmail}: ${row.content}\n`;
        if (out.length + piece.length > capBytes) break;
        out += piece;
    }
    return out;
}
