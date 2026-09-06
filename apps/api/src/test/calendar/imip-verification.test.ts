import { beforeAll, describe, expect, test } from 'bun:test';
import type { CalendarEventOccurrence } from '@workspace/lib/types/calendar';
import { getMailDomain } from '../../lib/config/server-config';
import { domainsAligned, verifyImipSender } from '../../lib/mail/imip-auth';
import { assertJson, authedRequest, getTestContext } from '../setup';

// Audit #4: inbound iMIP used to trust the spoofable `From:` header, so a spoofed REQUEST injected an
// event and a spoofed CANCEL with a known UID deleted a victim's meeting. It now acts only when our
// verifying MTA stamped an aligned DKIM pass in an Authentication-Results header with our authserv-id.
// Delivered on `charlie` in a dedicated 2026-11 window so the other suites' events never interfere.

describe('iMIP sender authentication (unit)', () => {
    const authserv = 'mail.example.com';

    const request = (from: string, ...authResults: string[]) =>
        verifyImipSender(authResults, authserv, from.split('@')[1] ?? null);

    test('an aligned dkim=pass from our authserv-id verifies', () => {
        expect(request('alice@partner.com', `${authserv}; dkim=pass header.d=partner.com`).verified).toBe(true);
    });

    test('a subdomain signing domain is relaxed-aligned', () => {
        expect(request('alice@partner.com', `${authserv}; dkim=pass header.d=mail.partner.com`).verified).toBe(true);
        expect(request('alice@mail.partner.com', `${authserv}; dkim=pass header.d=partner.com`).verified).toBe(true);
    });

    test('header.i is accepted in place of header.d', () => {
        expect(request('alice@partner.com', `${authserv}; dkim=pass header.i=@partner.com`).verified).toBe(true);
    });

    test('an unaligned signing domain does not verify', () => {
        expect(request('alice@partner.com', `${authserv}; dkim=pass header.d=attacker.net`).verified).toBe(false);
    });

    test('a dkim=fail does not verify', () => {
        expect(request('alice@partner.com', `${authserv}; dkim=fail header.d=partner.com`).verified).toBe(false);
    });

    test('no Authentication-Results header does not verify', () => {
        expect(request('alice@partner.com').verified).toBe(false);
    });

    test('a header from a different authserv-id is ignored', () => {
        expect(request('alice@partner.com', `relay.other.net; dkim=pass header.d=partner.com`).verified).toBe(false);
    });

    test('only the topmost header with our authserv-id is trusted (MTA prepends)', () => {
        // Our MTA prepends its own result; a header below it is a stale hop or a forgery. A genuine
        // fail on top must win over a forged pass beneath it.
        const verdict = request(
            'alice@partner.com',
            `${authserv}; dkim=fail header.d=partner.com`,
            `${authserv}; dkim=pass header.d=partner.com`,
        );
        expect(verdict.verified).toBe(false);
    });

    test('domainsAligned covers exact, subdomain, and unrelated', () => {
        expect(domainsAligned('partner.com', 'partner.com')).toBe(true);
        expect(domainsAligned('mail.partner.com', 'partner.com')).toBe(true);
        expect(domainsAligned('partner.com', 'partner.com.evil.net')).toBe(false);
        expect(domainsAligned('partner.com', 'attacker.net')).toBe(false);
    });
});

describe('iMIP inbound authentication (integration)', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;

    beforeAll(async () => {
        ctx = await getTestContext();
    });

    const invite = (uid: string, method: 'REQUEST' | 'CANCEL', summary: string) =>
        [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            `METHOD:${method}`,
            'PRODID:-//Partner//Calendar//EN',
            'BEGIN:VEVENT',
            `UID:${uid}`,
            `SUMMARY:${summary}`,
            'DTSTART:20261105T120000Z',
            'DTEND:20261105T130000Z',
            'SEQUENCE:0',
            method === 'CANCEL' ? 'STATUS:CANCELLED' : 'STATUS:CONFIRMED',
            'ORGANIZER;CN="Alice Partner":mailto:alice@partner.com',
            `ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;CN="Charlie":mailto:${ctx.charlie.user.email}`,
            'END:VEVENT',
            'END:VCALENDAR',
        ].join('\r\n');

    // Deliver an invite to Charlie with an explicit set of Authentication-Results header lines (in
    // document order, topmost first) — none passed means the message carries no such header.
    async function deliver(method: 'REQUEST' | 'CANCEL', ics: string, authResults: string[]): Promise<void> {
        const headerLines = authResults.map((v) => `Authentication-Results: ${v}`);
        const eml = [
            'From: alice@partner.com',
            ...headerLines,
            `To: ${ctx.charlie.user.email}`,
            `Subject: ${method === 'CANCEL' ? 'Cancelled' : 'Invitation'}: Partner Meeting`,
            'MIME-Version: 1.0',
            'Content-Type: multipart/mixed; boundary="verif-boundary"',
            '',
            '--verif-boundary',
            'Content-Type: text/plain',
            '',
            'Calendar invitation attached.',
            '--verif-boundary',
            `Content-Type: text/calendar; method=${method}; charset=utf-8`,
            'Content-Disposition: attachment; filename="invite.ics"',
            '',
            ics,
            '--verif-boundary--',
        ].join('\r\n');

        const res = await authedRequest(ctx.charlie.user.sessionToken, `/mail/deliver/${ctx.charlie.user.email}`, {
            method: 'POST',
            body: new TextEncoder().encode(eml).buffer,
        });
        // Delivery always succeeds — an unverified invite is kept as an attachment, never rejected.
        expect(res.status).toBe(200);
    }

    async function eventExists(uid: string): Promise<boolean> {
        const from = Math.floor(new Date('2026-11-04').getTime() / 1000);
        const to = Math.floor(new Date('2026-11-06').getTime() / 1000);
        const res = await authedRequest(
            ctx.charlie.user.sessionToken,
            `/calendar/${ctx.charlie.user.id}/event-range/${from}/${to}`,
        );
        const events = await assertJson<CalendarEventOccurrence[]>(res);
        return events.some((e) => e.uid === uid);
    }

    // Aligned DKIM pass as our verifying MTA would prepend it.
    const pass = (domain = 'partner.com') => `${getMailDomain()}; dkim=pass header.d=${domain}`;

    test('(a) a REQUEST with an aligned dkim=pass creates the event', async () => {
        const uid = 'verif-a@partner.com';
        await deliver('REQUEST', invite(uid, 'REQUEST', 'Partner Meeting A'), [pass()]);
        expect(await eventExists(uid)).toBe(true);
    });

    test('(b) a REQUEST with no Authentication-Results is not processed', async () => {
        const uid = 'verif-b@partner.com';
        await deliver('REQUEST', invite(uid, 'REQUEST', 'Partner Meeting B'), []);
        expect(await eventExists(uid)).toBe(false);
    });

    test('(c) a dkim=pass whose header.d is unaligned with From is not processed', async () => {
        const uid = 'verif-c@partner.com';
        await deliver('REQUEST', invite(uid, 'REQUEST', 'Partner Meeting C'), [pass('attacker.net')]);
        expect(await eventExists(uid)).toBe(false);
    });

    test('(d) a CANCEL without a pass leaves an existing invited event untouched', async () => {
        const uid = 'verif-d@partner.com';
        // A genuine, verified invite lands first.
        await deliver('REQUEST', invite(uid, 'REQUEST', 'Partner Meeting D'), [pass()]);
        expect(await eventExists(uid)).toBe(true);
        // A spoofed CANCEL (no DKIM pass) must not delete the victim's meeting.
        await deliver('CANCEL', invite(uid, 'CANCEL', 'Partner Meeting D'), []);
        expect(await eventExists(uid)).toBe(true);
    });

    test('(e) a forged pass below a genuine fail is ignored (topmost header wins)', async () => {
        const uid = 'verif-e@partner.com';
        // Topmost is the genuine result our MTA prepended (fail); the forged aligned pass sits below it.
        await deliver('REQUEST', invite(uid, 'REQUEST', 'Partner Meeting E'), [
            `${getMailDomain()}; dkim=fail header.d=partner.com`,
            `${getMailDomain()}; dkim=pass header.d=partner.com`,
        ]);
        expect(await eventExists(uid)).toBe(false);
    });
});
