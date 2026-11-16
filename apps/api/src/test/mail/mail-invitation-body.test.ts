// An invitation that travels as the message's body, the text/calendar part beside the text and the HTML, is the invite
// card's to draw when a calendar file beside it repeats it: no list of files counts it. Without that file, and for a
// calendar file a person attached, the part is a file.
import { beforeAll, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isListedFile } from '@workspace/lib/types/mail';
import { parseEmlBytes } from '../../lib/mail/mail-parse';
import { parseMail } from '../../lib/mail/mail-parser';
import type { OutboundMail } from '../../lib/mailer/mailer';
import { composeRfc822 } from '../../lib/mailer/mailer';
import { buildEmlPreviewPayload } from '../../lib/preview/eml-preview';
import { ensureServer } from '../setup';

beforeAll(async () => {
    await ensureServer();
});

const ICS = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    'UID:body-invite@example.com',
    'SUMMARY:Grant talk',
    'DTSTART:20260415T100000Z',
    'DTEND:20260415T110000Z',
    'END:VEVENT',
    'END:VCALENDAR',
].join('\r\n');

const base: OutboundMail = {
    from: { name: 'Fund', address: 'fund@example.com' },
    to: [{ name: 'Bram', address: 'bram@example.com' }],
    subject: 'Invitation: Grant talk',
    text: 'You are invited.',
    html: '<p>You are invited.</p>',
};

// The parse, the `.eml` preview's list of files and the list row's paperclip.
async function filesOf(mail: OutboundMail) {
    const bytes = await composeRfc822(mail);
    const parsed = parseMail(bytes);
    return {
        parsed,
        preview: buildEmlPreviewPayload(new Uint8Array(bytes).buffer).attachments.map((part) => part.filename),
        hasAttachments: parseEmlBytes('m1', 'INBOX', bytes).hasAttachments,
    };
}

test('an invitation built the way Eigen sends one lists only its invite.ics', async () => {
    const { parsed, preview } = await filesOf({ ...base, icalEvent: { method: 'REQUEST', content: ICS } });

    expect(preview).toEqual(['invite.ics']);
    // The invite card and the calendar still read the body part, which the reader's chips and a forward skip.
    expect(parsed.attachments.map(({ contentType, invitationBody }) => ({ contentType, invitationBody }))).toEqual([
        { contentType: 'text/calendar', invitationBody: true },
        { contentType: 'application/ics', invitationBody: undefined },
    ]);
});

test('an invitation that is only the body, as Outlook sends it, keeps the calendar part as its file', () => {
    const bytes = readFileSync(join(import.meta.dir, '../fixtures/mail-corpus/calendar-invitation-outlook.eml'));
    const listed = parseMail(bytes).attachments.filter(isListedFile);

    // The reader's chip and a forward read this list: the one file to save or import to Calendar.
    expect(listed.map((part) => part.contentType)).toEqual(['text/calendar']);
    expect(buildEmlPreviewPayload(new Uint8Array(bytes).buffer).attachments).toHaveLength(1);
    expect(parseEmlBytes('m1', 'INBOX', bytes).hasAttachments).toBe(true);
});

test('a message that is nothing but its calendar keeps it as a file', () => {
    const bytes = Buffer.from(
        ['From: fund@example.com', 'Subject: Grant talk', 'Content-Type: text/calendar; method=REQUEST', '', ICS].join(
            '\r\n',
        ),
    );

    expect(parseMail(bytes).attachments.filter(isListedFile)).toHaveLength(1);
});

test('a calendar file marked inline keeps its chip', () => {
    const bytes = Buffer.from(
        [
            'From: fund@example.com',
            'Subject: Festival',
            'Content-Type: multipart/mixed; boundary="mix"',
            '',
            '--mix',
            'Content-Type: text/plain',
            '',
            'The programme.',
            '--mix',
            'Content-Type: text/calendar; name="festival.ics"',
            'Content-Disposition: inline; filename="festival.ics"',
            '',
            ICS,
            '--mix--',
        ].join('\r\n'),
    );

    expect(
        parseMail(bytes)
            .attachments.filter(isListedFile)
            .map((part) => part.filename),
    ).toEqual(['festival.ics']);
    expect(buildEmlPreviewPayload(new Uint8Array(bytes).buffer).attachments.map((part) => part.filename)).toEqual([
        'festival.ics',
    ]);
});

test('a calendar file a person attached is one attachment', async () => {
    const { parsed, preview, hasAttachments } = await filesOf({
        ...base,
        attachments: [{ filename: 'festival.ics', content: Buffer.from(ICS), contentType: 'text/calendar' }],
    });

    expect(parsed.attachments.map((part) => part.invitationBody)).toEqual([undefined]);
    expect(preview).toEqual(['festival.ics']);
    expect(hasAttachments).toBe(true);
});
