// A chat's body for Drive's content search: its newest messages as plain text, one line per message, each
// line starting with its author's name and email. The content reindex queue reads it when a chat file is due,
// the way it extracts any other document. It holds the chat's data.db only while it reads.

import type { DrivePath } from '@workspace/lib/types/drive';
import { and, sql } from 'drizzle-orm';
import { searchableMessageText, searchablePerson } from '../chat/commands';
import { CHAT_ROOM_DB_CONFIG } from '../chat/db-config';
import { messages, NEWEST_FIRST, olderThan, SEARCHABLE_MESSAGES } from '../chat/schema';
import type { Mount } from '../mount';
import { CONTAINER_DATA_DB } from '../mount/container-dbs';

const CHAT_CONTENT_PAGE = 512;

// The newest searchable messages of a chat, up to capBytes, because they best answer a search for the chat
// that mentioned something. It reads from the end through idx_messages_createdAt and never scans the chat.
export async function readChatContent(mount: Mount, drivePath: DrivePath, capBytes: number): Promise<string> {
    const dataDbPath = await mount.getChildByName(drivePath.id, CONTAINER_DATA_DB);
    if (!dataDbPath) return '';

    // A chat has few authors, so each one is looked up once and not once per line.
    const authors = new Map<string, Promise<string>>();
    const author = (email: string) => {
        let person = authors.get(email);
        if (!person) {
            person = searchablePerson(email);
            authors.set(email, person);
        }
        return person;
    };

    // It reads the newest messages a page at a time, on the same keyset as getMessagesForUser, and stops once
    // `out` reaches capBytes. So a long chat never loads more than one page past the cap.
    return mount.withDatabase(CHAT_ROOM_DB_CONFIG, dataDbPath.id, async (managedDb) => {
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
                const piece = `${await author(row.authorEmail)}: ${await searchableMessageText(row)}\n`;
                if (out.length + piece.length > capBytes) return out;
                out += piece;
            }
            if (page.length < CHAT_CONTENT_PAGE) break;
            before = page[page.length - 1];
        }
        return out;
    });
}
