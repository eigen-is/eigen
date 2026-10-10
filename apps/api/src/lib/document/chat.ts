import type { DrivePath } from '@workspace/lib/types/drive';
import { and, sql } from 'drizzle-orm';
import { searchableMessageText } from '../chat/commands';
import { CHAT_ROOM_DB_CONFIG } from '../chat/db-config';
import { messages, NEWEST_FIRST, olderThan, SEARCHABLE_MESSAGES } from '../chat/schema';
import type { Mount } from '../mount';

const CHAT_CONTENT_PAGE = 512;

// Drive-wide view of a chat: the NEWEST searchable messages up to capBytes (most relevant for
// "find the chat that mentioned X"). Reads the tail cheaply via idx_messages_createdAt;
// no full scan, no Yjs (chat's data.db is a relational ManagedDatabase).
export async function readChatContent(mount: Mount, drivePath: DrivePath, capBytes: number): Promise<string> {
    const dataDbPath = await mount.getChildByName(drivePath.id, 'data.db');
    if (!dataDbPath) return '';

    const managedDb = await mount.openDatabase(CHAT_ROOM_DB_CONFIG, dataDbPath.id);

    // Walk the newest messages a page at a time, on getMessages' keyset, and stop the moment `out` reaches
    // capBytes, so a long chat never materialises more than one page past the cap.
    let out = '';
    let before: { createdAt: Date; rowid: number } | undefined;
    while (out.length < capBytes) {
        const page = managedDb.db
            .select({
                type: messages.type,
                content: messages.content,
                authorEmail: messages.authorEmail,
                createdAt: messages.createdAt,
                rowid: sql<number>`rowid`,
            })
            .from(messages)
            .where(and(SEARCHABLE_MESSAGES, before && olderThan(before)))
            .orderBy(...NEWEST_FIRST)
            .limit(CHAT_CONTENT_PAGE)
            .all();
        for (const row of page) {
            const piece = `${row.authorEmail}: ${searchableMessageText(row)}\n`;
            if (out.length + piece.length > capBytes) return out;
            out += piece;
        }
        if (page.length < CHAT_CONTENT_PAGE) break;
        before = page[page.length - 1];
    }
    return out;
}
