import { beforeAll, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EmailSummary, MaildirMailbox } from '@workspace/lib/types/mail';
import {
    applyFlagsFromFilename,
    buildMaildirFilename,
    createUniqueMessageId,
    getMailIDfromFileName,
    parseFlagsFromFilename,
    rebuildFlagsSuffix,
} from '../../lib/mail/mailutils';
import { assertJson, authedRequest, findOrFail, getTestContext, TEST_DATA_DIR } from '../setup';

const isWindows = process.platform === 'win32';

function userMaildir(userId: string) {
    return join(TEST_DATA_DIR, 'home', userId, 'eigen.mail', 'Maildir');
}

function curDir(userId: string, mailbox: string) {
    const base = userMaildir(userId);
    return mailbox === '' ? join(base, 'cur') : join(base, `.${mailbox}`, 'cur');
}

function newDir(userId: string, mailbox: string) {
    const base = userMaildir(userId);
    return mailbox === '' ? join(base, 'new') : join(base, `.${mailbox}`, 'new');
}

function makeEml(subject: string, from = 'test@example.com') {
    return [
        `From: ${from}`,
        `To: alice@test.eigen.is`,
        `Subject: ${subject}`,
        `Date: ${new Date().toUTCString()}`,
        `Message-ID: <${Date.now()}@test>`,
        `MIME-Version: 1.0`,
        `Content-Type: text/plain; charset=utf-8`,
        '',
        `Body of ${subject}`,
    ].join('\r\n');
}

// EML with a raw ISO-8859-1 'é' (0xE9) body byte — invalid UTF-8, so a TextDecoder/`.text()`
// round-trip would replace it with U+FFFD (0xEF 0xBF 0xBD) and inflate the byte count.
function makeRawNonUtf8Eml(subject: string, to: string, marker: string): Buffer {
    const headers = [
        'From: sender@example.com',
        `To: ${to}`,
        `Subject: ${subject}`,
        `Date: ${new Date().toUTCString()}`,
        `Message-ID: <${marker}@test>`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=iso-8859-1',
        'Content-Transfer-Encoding: 8bit',
    ].join('\r\n');
    return Buffer.concat([
        Buffer.from(`${headers}\r\n\r\n`, 'ascii'),
        Buffer.from([0x43, 0x61, 0x66, 0xe9]), // "Caf" + ISO-8859-1 é
        Buffer.from('\r\n', 'ascii'),
    ]);
}

describe('Maildir Utility Functions', () => {
    test('createUniqueMessageId produces Maildir-compatible format', () => {
        const id = createUniqueMessageId();
        expect(id).toMatch(/^\d+\.M\d+P\d+Q\d+\./);
        expect(id).not.toContain('.eml');

        const id2 = createUniqueMessageId();
        expect(id).not.toBe(id2);
    });

    test('getMailIDfromFileName strips flags and size hint', () => {
        expect(getMailIDfromFileName('1709234567.M412345P9876.host,S=4523:2,RS')).toBe('1709234567.M412345P9876.host');
        expect(getMailIDfromFileName('1709234567.M412345P9876.host:2,S')).toBe('1709234567.M412345P9876.host');
        expect(getMailIDfromFileName('1709234567.M412345P9876.host')).toBe('1709234567.M412345P9876.host');
        expect(getMailIDfromFileName('abc,S=100:2,DS')).toBe('abc');
    });

    test('parseFlagsFromFilename extracts all standard flags', () => {
        const flags = parseFlagsFromFilename('msg:2,DFPRST');
        expect(flags.seen).toBe(true);
        expect(flags.replied).toBe(true);
        expect(flags.flagged).toBe(true);
        expect(flags.draft).toBe(true);
        expect(flags.trashed).toBe(true);
        expect(flags.forwarded).toBe(true);
    });

    test('parseFlagsFromFilename returns false for absent flags', () => {
        const flags = parseFlagsFromFilename('msg:2,');
        expect(flags.seen).toBe(false);
        expect(flags.replied).toBe(false);
        expect(flags.flagged).toBe(false);
    });

    test('parseFlagsFromFilename handles no colon', () => {
        const flags = parseFlagsFromFilename('msgwithoutflags');
        expect(flags.seen).toBe(false);
    });

    test('buildMaildirFilename produces sorted flags', () => {
        const filename = buildMaildirFilename('unique123', { seen: true, draft: true, flagged: true }, 500);
        expect(filename).toBe('unique123,S=500:2,DFS');
    });

    test('buildMaildirFilename with no flags', () => {
        const filename = buildMaildirFilename('unique123', {}, 100);
        expect(filename).toBe('unique123,S=100:2,');
    });

    test('rebuildFlagsSuffix preserves Dovecot keyword flags', () => {
        // lowercase 'ab' are Dovecot custom keywords
        const result = rebuildFlagsSuffix('msg:2,Sab', { replied: true });
        expect(result).toBe('RSab');
    });

    test('rebuildFlagsSuffix removes standard flag', () => {
        const result = rebuildFlagsSuffix('msg:2,RS', { seen: false });
        expect(result).toBe('R');
    });

    test('applyFlagsFromFilename sets email flags', () => {
        const email = { isRead: false, isFlagged: false, isDraft: false, isReplied: false } as EmailSummary;
        applyFlagsFromFilename(email, 'msg,S=100:2,DFS');
        expect(email.isRead).toBe(true);
        expect(email.isFlagged).toBe(true);
        expect(email.isDraft).toBe(true);
        expect(email.isReplied).toBe(false);
    });
});

describe.skipIf(isWindows)('IMAP/Dovecot Maildir Compatibility', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let charlieId: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        charlieId = ctx.charlie.user.id;
        // Ensure Charlie's Maildir is fully initialized before tests write files
        await authedRequest(ctx.charlie.user.sessionToken, `/mail/${charlieId}/mailboxes`);
    });

    // A non-empty mailbox is served stale + reconciled by a background sync (Step 3). Poll until
    // an external maildir change is picked up, then assert.
    async function pollList(box: string, predicate: (rows: EmailSummary[]) => boolean): Promise<EmailSummary[]> {
        let rows: EmailSummary[] = [];
        for (let i = 0; i < 60; i++) {
            rows = await assertJson<EmailSummary[]>(
                await authedRequest(ctx.charlie.user.sessionToken, `/mail/${charlieId}/mailbox/${box}`),
            );
            if (predicate(rows)) return rows;
            await Bun.sleep(50);
        }
        return rows; // let the caller's assertion produce the failure message
    }

    // -- Mailbox structure --

    test('standard mailboxes use canonical case', async () => {
        const res = await authedRequest(ctx.charlie.user.sessionToken, `/mail/${charlieId}/mailboxes`);
        const data = await assertJson<MaildirMailbox[]>(res);

        const names = data.map((m) => m.path);
        expect(names).toContain('');
        expect(names).toContain('Sent');
        expect(names).toContain('Drafts');
        expect(names).toContain('Trash');
        expect(names).toContain('Junk');
        expect(names).toContain('Archive');
        expect(names).not.toContain('Spam');
    });

    test('mailbox directories use dot-prefix with canonical case', () => {
        const maildir = userMaildir(charlieId);
        const entries = readdirSync(maildir);
        expect(entries).toContain('.Sent');
        expect(entries).toContain('.Drafts');
        expect(entries).toContain('.Trash');
        expect(entries).toContain('.Junk');
        expect(entries).toContain('.Archive');
        expect(entries).not.toContain('.sent');
        expect(entries).not.toContain('.spam');
    });

    test('maildirfolder marker exists in subfolders', () => {
        const maildir = userMaildir(charlieId);
        for (const folder of ['Sent', 'Drafts', 'Trash', 'Junk', 'Archive']) {
            const marker = join(maildir, `.${folder}`, 'maildirfolder');
            expect(() => readFileSync(marker)).not.toThrow();
        }
    });

    test('subscriptions file lists all standard folders', () => {
        const subscriptions = readFileSync(join(userMaildir(charlieId), 'subscriptions'), 'utf-8');
        expect(subscriptions).toContain('Sent');
        expect(subscriptions).toContain('Drafts');
        expect(subscriptions).toContain('Trash');
        expect(subscriptions).toContain('Junk');
        expect(subscriptions).toContain('Archive');
    });

    // -- Filename format --

    test('delivered messages use Maildir filename format', async () => {
        const eml = makeEml('Filename Format Test');
        await authedRequest(ctx.charlie.user.sessionToken, `/mail/${charlieId}/mailbox`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mailbox: 'TestFilenames' }),
        });

        // Deliver via public endpoint
        const res = await ctx.app.handle(
            new Request(`http://localhost/mail/deliver/${ctx.charlie.user.email}`, {
                method: 'POST',
                headers: { 'Content-Type': 'message/rfc822' },
                body: new TextEncoder().encode(eml).buffer,
            }),
        );
        expect(res.status).toBe(200);

        // Check files in cur/
        const files = readdirSync(curDir(charlieId, ''));
        const newFile = findOrFail(files, (f) => !f.endsWith('.eml') && f.includes(':2,'));
        expect(newFile).toMatch(/^\d+\.M\d+P\d+Q\d+\..+,S=\d+:2,/);
    });

    // -- Draft delivery --

    test('drafts are delivered to cur/ with D and S flags', async () => {
        const res = await authedRequest(ctx.charlie.user.sessionToken, `/mail/${charlieId}/message/draft`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mail: { subject: 'Draft Flag Test', text: 'draft body' } }),
        });
        const data = await assertJson<EmailSummary>(res);

        expect(data.isDraft).toBe(true);
        expect(data.isRead).toBe(true);
        expect(data.filename).toMatch(/:2,DS$/);
    });

    // -- Flag operations --

    test('messageSetRead renames file with S flag', async () => {
        const draftRes = await authedRequest(ctx.charlie.user.sessionToken, `/mail/${charlieId}/message/draft`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mail: { subject: 'Read Flag Test', text: 'body' } }),
        });
        const draft = await assertJson<EmailSummary>(draftRes);

        // Mark as unread (remove S flag)
        await authedRequest(ctx.charlie.user.sessionToken, `/mail/${charlieId}/message/${draft.id}/read`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ read: false }),
        });

        // Verify file on disk
        const files = readdirSync(curDir(charlieId, 'Drafts'));
        const file = findOrFail(files, (f) => f.startsWith(draft.id));
        const flags = parseFlagsFromFilename(file);
        expect(flags.seen).toBe(false);
        expect(flags.draft).toBe(true);
    });

    test('messageSetFlagged renames file with F flag', async () => {
        const draftRes = await authedRequest(ctx.charlie.user.sessionToken, `/mail/${charlieId}/message/draft`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mail: { subject: 'Flagged Test', text: 'body' } }),
        });
        const draft = await assertJson<EmailSummary>(draftRes);

        // Set flagged
        const res = await authedRequest(
            ctx.charlie.user.sessionToken,
            `/mail/${charlieId}/message/${draft.id}/flagged`,
            {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ flagged: true }),
            },
        );
        expect(res.status).toBe(200);

        // Verify file on disk has F flag
        const files = readdirSync(curDir(charlieId, 'Drafts'));
        const file = findOrFail(files, (f) => f.startsWith(draft.id));
        const flags = parseFlagsFromFilename(file);
        expect(flags.flagged).toBe(true);

        // Verify via API
        const getRes = await authedRequest(ctx.charlie.user.sessionToken, `/mail/${charlieId}/message/${draft.id}`);
        const msg = await assertJson<EmailSummary>(getRes);
        expect(msg.isFlagged).toBe(true);
    });

    test('set flagged on unknown message returns 404', async () => {
        const res = await authedRequest(
            ctx.charlie.user.sessionToken,
            `/mail/${charlieId}/message/nonexistent/flagged`,
            {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ flagged: true }),
            },
        );
        expect(res.status).toBe(404);
    });

    // -- Simulated Dovecot: external file changes --

    test('sync detects new message placed in cur/ by Dovecot', async () => {
        const eml = makeEml('Dovecot Delivered', 'dovecot@example.com');
        const uniqueId = `9999999.M0P1Q0.dovecot-test`;
        const size = Buffer.byteLength(eml, 'utf-8');
        const filename = `${uniqueId},S=${size}:2,S`;

        // Simulate Dovecot placing a file directly in cur/
        writeFileSync(join(curDir(charlieId, ''), filename), eml);

        // Background sync reconciles it eventually — poll until it shows up.
        const messages = await pollList('inbox', (rows) => rows.some((m) => m.id === uniqueId));

        const found = findOrFail(messages, (m) => m.id === uniqueId);
        expect(found.subject).toBe('Dovecot Delivered');
        expect(found.fromShort).toContain('dovecot@example.com');
        expect(found.isRead).toBe(true);
    });

    test('sync detects new message placed in new/ (standalone mode)', async () => {
        const eml = makeEml('Standalone New');
        const uniqueId = `9999998.M0P1Q1.standalone-test`;
        const size = Buffer.byteLength(eml, 'utf-8');
        const filename = `${uniqueId},S=${size}`;

        // Place in new/ (no :2, suffix — raw delivery)
        writeFileSync(join(newDir(charlieId, ''), filename), eml);

        // Background sync reconciles it eventually — poll until it shows up.
        const messages = await pollList('inbox', (rows) => rows.some((m) => m.id === uniqueId));

        const found = findOrFail(messages, (m) => m.id === uniqueId);
        expect(found.subject).toBe('Standalone New');
        expect(found.isRead).toBe(false);
    });

    test('sync detects flag changes made by Dovecot', async () => {
        // Create a draft via API (has :2,DS flags)
        const draftRes = await authedRequest(ctx.charlie.user.sessionToken, `/mail/${charlieId}/message/draft`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mail: { subject: 'Flag Change Test', text: 'body' } }),
        });
        const draft = await assertJson<EmailSummary>(draftRes);

        // Find the file on disk
        const draftsDir = curDir(charlieId, 'Drafts');
        const files = readdirSync(draftsDir);
        const originalFile = findOrFail(files, (f) => f.startsWith(draft.id));

        // Simulate Dovecot renaming the file to add R (Replied) and F (Flagged) flags
        const uniqueWithSize = originalFile.split(':')[0];
        const newFilename = `${uniqueWithSize}:2,DFRS`;
        renameSync(join(draftsDir, originalFile), join(draftsDir, newFilename));

        // Poll until the background sync picks up the renamed flags, THEN read the message — this
        // waits out the transient 500 window where the DB still points at the pre-rename filename.
        await pollList('Drafts', (rows) => rows.some((m) => m.id === draft.id && m.isFlagged && m.isReplied));

        // Verify flags updated in DB
        const getRes = await authedRequest(ctx.charlie.user.sessionToken, `/mail/${charlieId}/message/${draft.id}`);
        const msg = await assertJson<EmailSummary>(getRes);
        expect(msg.isReplied).toBe(true);
        expect(msg.isFlagged).toBe(true);
        expect(msg.isRead).toBe(true);
        expect(msg.isDraft).toBe(true);
    });

    test('sync detects message deleted by Dovecot (expunge)', async () => {
        const draftRes = await authedRequest(ctx.charlie.user.sessionToken, `/mail/${charlieId}/message/draft`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mail: { subject: 'Will Be Expunged', text: 'bye' } }),
        });
        const draft = await assertJson<EmailSummary>(draftRes);

        // Verify it exists
        const beforeRes = await authedRequest(ctx.charlie.user.sessionToken, `/mail/${charlieId}/message/${draft.id}`);
        expect(beforeRes.status).toBe(200);

        // Simulate Dovecot expunging (deleting the file)
        const draftsDir = curDir(charlieId, 'Drafts');
        const files = readdirSync(draftsDir);
        const draftFile = findOrFail(files, (f) => f.startsWith(draft.id));
        unlinkSync(join(draftsDir, draftFile));

        // Poll until the background sync removes the stale DB row — only then is the message GET
        // a clean 404, not the transient 500 mid-reconcile.
        await pollList('Drafts', (rows) => !rows.some((m) => m.id === draft.id));

        // Message should be gone
        const afterRes = await authedRequest(ctx.charlie.user.sessionToken, `/mail/${charlieId}/message/${draft.id}`);
        expect(afterRes.status).toBe(404);
    });

    test('sync detects message moved between mailboxes by Dovecot', async () => {
        // Deliver a message to inbox
        const eml = makeEml('Dovecot Move Test');
        const uniqueId = `9999997.M0P1Q2.move-test`;
        const size = Buffer.byteLength(eml, 'utf-8');
        const filename = `${uniqueId},S=${size}:2,S`;

        writeFileSync(join(curDir(charlieId, ''), filename), eml);

        // Poll inbox until the background sync indexes it, so it's in DB before we read it.
        await pollList('inbox', (rows) => rows.some((m) => m.id === uniqueId));

        // Verify it's there
        const getRes = await authedRequest(ctx.charlie.user.sessionToken, `/mail/${charlieId}/message/${uniqueId}`);
        expect(getRes.status).toBe(200);

        // Simulate Dovecot IMAP MOVE: delete from inbox cur/, place in Archive cur/
        unlinkSync(join(curDir(charlieId, ''), filename));
        writeFileSync(join(curDir(charlieId, 'Archive'), filename), eml);

        // Poll both mailboxes until the move is reconciled: gone from inbox, present in Archive.
        await pollList('inbox', (rows) => !rows.some((m) => m.id === uniqueId));
        const archiveMessages = await pollList('Archive', (rows) => rows.some((m) => m.id === uniqueId));

        // Present in archive
        const inArchive = findOrFail(archiveMessages, (m) => m.id === uniqueId);
        expect(inArchive.mailbox).toBe('Archive');
    });

    test('sync preserves Dovecot custom keyword flags (lowercase)', async () => {
        const eml = makeEml('Keyword Flags Test');
        const uniqueId = `9999996.M0P1Q3.keyword-test`;
        const size = Buffer.byteLength(eml, 'utf-8');
        // Dovecot adds lowercase keyword flags 'ab' alongside standard flags
        const filename = `${uniqueId},S=${size}:2,Sab`;

        writeFileSync(join(curDir(charlieId, ''), filename), eml);

        // Poll until the background sync indexes it.
        const messages = await pollList('inbox', (rows) => rows.some((m) => m.id === uniqueId));

        // Message is seen (S flag), but Eigen preserves the 'ab' keyword flags
        const found = findOrFail(messages, (m) => m.id === uniqueId);
        expect(found.isRead).toBe(true);

        // Now toggle read off via API — should produce :2,ab (preserving keywords)
        await authedRequest(ctx.charlie.user.sessionToken, `/mail/${charlieId}/message/${uniqueId}/read`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ read: false }),
        });

        const files = readdirSync(curDir(charlieId, ''));
        const renamedFile = findOrFail(files, (f) => f.startsWith(uniqueId));
        // Should have keyword flags but no S
        expect(renamedFile).toMatch(/:2,ab$/);
    });

    // -- Case-insensitive mailbox lookup --

    test('mailboxGet normalizes lowercase mailbox names', async () => {
        // API receives "sent" from frontend URL but should map to "Sent"
        const res = await authedRequest(ctx.charlie.user.sessionToken, `/mail/${charlieId}/mailbox/sent`);
        expect(res.status).toBe(200);
    });

    test('mailboxGet normalizes inbox variants', async () => {
        const res = await authedRequest(ctx.charlie.user.sessionToken, `/mail/${charlieId}/mailbox/INBOX`);
        expect(res.status).toBe(200);
    });

    // -- Move preserves flags --

    test('message move preserves flags in filename', async () => {
        // Create a draft and flag it
        const draftRes = await authedRequest(ctx.charlie.user.sessionToken, `/mail/${charlieId}/message/draft`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mail: { subject: 'Move Flags', text: 'body' } }),
        });
        const draft = await assertJson<EmailSummary>(draftRes);

        await authedRequest(ctx.charlie.user.sessionToken, `/mail/${charlieId}/message/${draft.id}/flagged`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ flagged: true }),
        });

        // Move to Archive
        await authedRequest(ctx.charlie.user.sessionToken, `/mail/${charlieId}/message/move`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messageId: draft.id, targetMailbox: 'Archive' }),
        });

        // Check file in Archive cur/
        const files = readdirSync(curDir(charlieId, 'Archive'));
        const movedFile = findOrFail(files, (f) => f.startsWith(draft.id));
        const flags = parseFlagsFromFilename(movedFile);
        expect(flags.flagged).toBe(true);
        expect(flags.draft).toBe(true);
        expect(flags.seen).toBe(true);
    });

    // -- Copy creates new message --

    test('messageCopy creates independent copy in target mailbox', async () => {
        const draftRes = await authedRequest(ctx.charlie.user.sessionToken, `/mail/${charlieId}/message/draft`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mail: { subject: 'Copy Source', text: 'body' } }),
        });
        const draft = await assertJson<EmailSummary>(draftRes);

        // Copy to Archive
        const copyRes = await authedRequest(ctx.charlie.user.sessionToken, `/mail/${charlieId}/message/copy`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messageId: draft.id, targetMailbox: 'Archive' }),
        });
        expect(copyRes.status).toBe(200);

        // Original still in Drafts
        const draftsRes = await authedRequest(ctx.charlie.user.sessionToken, `/mail/${charlieId}/mailbox/Drafts`);
        const drafts = await assertJson<EmailSummary[]>(draftsRes);
        expect(drafts.some((m) => m.id === draft.id)).toBe(true);

        // Copy in Archive (different message ID)
        const archiveRes = await authedRequest(ctx.charlie.user.sessionToken, `/mail/${charlieId}/mailbox/Archive`);
        const archive = await assertJson<EmailSummary[]>(archiveRes);
        findOrFail(archive, (m) => m.subject === 'Copy Source' && m.id !== draft.id);
    });

    // -- Atomic delivery --

    test('deliverAtomic goes through tmp then new', async () => {
        const eml = makeEml('Atomic Delivery');
        const res = await ctx.app.handle(
            new Request(`http://localhost/mail/deliver/${ctx.charlie.user.email}`, {
                method: 'POST',
                headers: { 'Content-Type': 'message/rfc822' },
                body: new TextEncoder().encode(eml).buffer,
            }),
        );
        expect(res.status).toBe(200);

        // After delivery + sync, file should be in cur/, not new/ or tmp/
        const newFiles = readdirSync(newDir(charlieId, ''));
        const curFiles = readdirSync(curDir(charlieId, ''));
        const tmpDir = join(userMaildir(charlieId), 'tmp');
        const tmpFiles = readdirSync(tmpDir);

        // tmp should be empty (file moved to new then to cur)
        expect(tmpFiles.filter((f) => !f.startsWith('.')).length).toBe(0);
        // new should be empty (sync moved to cur)
        expect(newFiles.filter((f) => f.includes('Atomic')).length).toBe(0);
        // cur should have the file
        expect(curFiles.some((f) => f.includes(':2,'))).toBe(true);
    });

    test('inbound non-UTF-8 mail is written to disk byte-for-byte', async () => {
        const marker = `latin1-${crypto.randomUUID()}`;
        const rawEml = makeRawNonUtf8Eml('Latin-1 body', ctx.charlie.user.email, marker);

        const res = await ctx.app.handle(
            new Request(`http://localhost/mail/deliver/${ctx.charlie.user.email}`, {
                method: 'POST',
                headers: { 'Content-Type': 'message/rfc822' },
                body: new Uint8Array(rawEml),
            }),
        );
        expect(res.status).toBe(200);

        const dir = curDir(charlieId, '');
        const deliveredFile = findOrFail(readdirSync(dir), (f) => readFileSync(join(dir, f)).includes(marker));
        const onDisk = readFileSync(join(dir, deliveredFile));

        // Byte-identical to what arrived — a UTF-8 round-trip would replace 0xE9 with U+FFFD.
        expect(Buffer.compare(onDisk, rawEml)).toBe(0);
        expect(onDisk.includes(0xe9)).toBe(true);

        // Size hint reflects the real byte count, not a mangled string length.
        const size = Number(deliveredFile.match(/,S=(\d+)/)?.[1]);
        expect(size).toBe(rawEml.byteLength);
    });

    test('messageCopy preserves non-UTF-8 bytes verbatim', async () => {
        // Place a raw non-UTF-8 message directly in cur/ (as Dovecot would) so the copy path is tested
        // independently of delivery.
        const marker = `copy-latin1-${crypto.randomUUID()}`;
        const rawEml = makeRawNonUtf8Eml('Copy Latin-1', ctx.charlie.user.email, marker);
        const uniqueId = createUniqueMessageId();
        writeFileSync(join(curDir(charlieId, ''), `${uniqueId},S=${rawEml.byteLength}:2,S`), rawEml);

        // Poll until the background sync learns of it, then copy to Archive.
        await pollList('inbox', (rows) => rows.some((m) => m.id === uniqueId));
        const copyRes = await authedRequest(ctx.charlie.user.sessionToken, `/mail/${charlieId}/message/copy`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messageId: uniqueId, targetMailbox: 'Archive' }),
        });
        expect(copyRes.status).toBe(200);

        const archiveDir = curDir(charlieId, 'Archive');
        const copiedFile = findOrFail(readdirSync(archiveDir), (f) =>
            readFileSync(join(archiveDir, f)).includes(marker),
        );
        const copied = readFileSync(join(archiveDir, copiedFile));

        expect(Buffer.compare(copied, rawEml)).toBe(0);
        expect(copied.includes(0xe9)).toBe(true);
    });
});
