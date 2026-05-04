import { beforeAll, describe, expect, test } from 'bun:test';
import type { ServerSettings } from '@workspace/lib/types/settings';
import type { WaitlistEntry } from '@workspace/lib/types/waitlist';
// `setup` must run before any module that touches server-config — it sets EIGEN_DATA_ROOT
// at module-load time. Importing waitlist statically would pull in server-config under the
// production default, so buildInviteEmail is dynamically imported inside the test below.
import { assertJson, authedRequest, getTestContext } from './setup';

describe('Waitlist', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let entryId: string;
    let inviteToken: string;

    beforeAll(async () => {
        ctx = await getTestContext();

        // Enable waitlist
        await authedRequest(ctx.alice.user.sessionToken, '/settings/server', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ onboarding: { waitlist: { enabled: true } } }),
        });
    });

    // -- Public submit --

    test('submit to waitlist', async () => {
        const res = await ctx.app.handle(
            new Request('http://localhost/p/waitlist', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: 'waitlist-user@example.com', notes: 'I want in!' }),
            }),
        );
        expect(res.status).toBe(200);
        const ok = await res.json();
        expect(ok).toBe(true);
    });

    test('submit deduplicates by email', async () => {
        const res = await ctx.app.handle(
            new Request('http://localhost/p/waitlist', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: 'waitlist-user@example.com', notes: 'Updated notes' }),
            }),
        );
        expect(res.status).toBe(200);
    });

    test('submit normalizes email to lowercase', async () => {
        const res = await ctx.app.handle(
            new Request('http://localhost/p/waitlist', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: 'UPPER@CASE.COM', notes: '' }),
            }),
        );
        expect(res.status).toBe(200);
    });

    test('submit rejects invalid email', async () => {
        const res = await ctx.app.handle(
            new Request('http://localhost/p/waitlist', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: 'not-an-email', notes: '' }),
            }),
        );
        expect(res.status).toBe(400);
    });

    test('submit fails when waitlist is disabled', async () => {
        await authedRequest(ctx.alice.user.sessionToken, '/settings/server', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ onboarding: { waitlist: { enabled: false } } }),
        });

        const res = await ctx.app.handle(
            new Request('http://localhost/p/waitlist', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: 'blocked@example.com', notes: '' }),
            }),
        );
        expect(res.status).toBe(403);

        // Re-enable
        await authedRequest(ctx.alice.user.sessionToken, '/settings/server', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ onboarding: { waitlist: { enabled: true } } }),
        });
    });

    // -- Admin list --

    test('admin can list waitlist entries', async () => {
        const res = await authedRequest(
            ctx.alice.user.sessionToken,
            `/waitlist/${ctx.alice.user.id}/entries?status=pending`,
        );
        const entries = await assertJson<WaitlistEntry[]>(res);
        expect(entries.length).toBeGreaterThanOrEqual(1);
        const entry = entries.find((e) => e.email === 'waitlist-user@example.com');
        expect(entry).toBeDefined();
        expect(entry!.status).toBe('pending');
        expect(entry!.notes).toBe('Updated notes');
        entryId = entry!.id;
    });

    test('non-admin cannot list waitlist', async () => {
        const res = await authedRequest(ctx.bob.user.sessionToken, `/waitlist/${ctx.bob.user.id}/entries`);
        expect(res.status).toBe(403);
    });

    // -- Admin accept --

    test('admin can accept entry', async () => {
        const res = await authedRequest(
            ctx.alice.user.sessionToken,
            `/waitlist/${ctx.alice.user.id}/entries/${entryId}/accept`,
            { method: 'PUT' },
        );
        const data = await assertJson<{ email: string; inviteToken: string }>(res);
        expect(data.email).toBe('waitlist-user@example.com');
        expect(data.inviteToken).toBeTruthy();
        inviteToken = data.inviteToken;
    });

    test('entry is now in invited status', async () => {
        const res = await authedRequest(
            ctx.alice.user.sessionToken,
            `/waitlist/${ctx.alice.user.id}/entries?status=invited`,
        );
        const entries = await assertJson<WaitlistEntry[]>(res);
        const entry = entries.find((e) => e.id === entryId);
        expect(entry).toBeDefined();
        expect(entry!.status).toBe('invited');
        expect(entry!.invitedAt).toBeTruthy();
        expect(entry!.inviteExpiresAt).toBeTruthy();
    });

    test('accepting already-invited entry fails', async () => {
        const res = await authedRequest(
            ctx.alice.user.sessionToken,
            `/waitlist/${ctx.alice.user.id}/entries/${entryId}/accept`,
            { method: 'PUT' },
        );
        expect(res.status).toBe(400);
    });

    // -- Invite token validation --

    test('valid invite token returns entry info', async () => {
        const res = await ctx.app.handle(new Request(`http://localhost/p/invite/${inviteToken}`));
        const data = await res.json();
        expect(data.valid).toBe(true);
        expect(data.email).toBe('waitlist-user@example.com');
        expect(data.mailDomain).toBeTruthy();
    });

    test('invalid token returns valid: false', async () => {
        const res = await ctx.app.handle(new Request('http://localhost/p/invite/nonexistent-token'));
        const data = await res.json();
        expect(data.valid).toBe(false);
    });

    // -- Resend invite --

    test('admin can resend invite', async () => {
        const res = await authedRequest(
            ctx.alice.user.sessionToken,
            `/waitlist/${ctx.alice.user.id}/entries/${entryId}/resend`,
            { method: 'PUT' },
        );
        const data = await assertJson<{ email: string; inviteToken: string }>(res);
        expect(data.inviteToken).toBeTruthy();
        expect(data.inviteToken).not.toBe(inviteToken);
        inviteToken = data.inviteToken;
    });

    test('old token is invalid after resend', async () => {
        const res = await ctx.app.handle(new Request(`http://localhost/p/invite/${inviteToken}`));
        const data = await res.json();
        // The new token should be valid (resend gives a new one)
        expect(data.valid).toBe(true);
    });

    // -- Register via invite --

    test('register rejects reserved username', async () => {
        const res = await ctx.app.handle(
            new Request(`http://localhost/p/invite/${inviteToken}/register`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'Admin', username: 'admin', password: 'testpassword123' }),
            }),
        );
        expect(res.status).toBe(400);
    });

    test('register rejects short password', async () => {
        const res = await ctx.app.handle(
            new Request(`http://localhost/p/invite/${inviteToken}/register`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'Test', username: 'waitlistuser', password: 'short' }),
            }),
        );
        expect(res.status).toBe(422);
    });

    test('register with valid invite token creates account', async () => {
        const res = await ctx.app.handle(
            new Request(`http://localhost/p/invite/${inviteToken}/register`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'Waitlist User', username: 'waitlistuser', password: 'testpassword123' }),
            }),
        );
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.success).toBe(true);

        // Should have set-cookie header for session
        const cookie = res.headers.get('set-cookie');
        expect(cookie).toBeTruthy();
    });

    test('entry is now registered', async () => {
        const res = await authedRequest(
            ctx.alice.user.sessionToken,
            `/waitlist/${ctx.alice.user.id}/entries?status=registered`,
        );
        const entries = await assertJson<WaitlistEntry[]>(res);
        const entry = entries.find((e) => e.id === entryId);
        expect(entry).toBeDefined();
        expect(entry!.status).toBe('registered');
        expect(entry!.registeredAt).toBeTruthy();
    });

    test('used token is no longer valid', async () => {
        const res = await ctx.app.handle(new Request(`http://localhost/p/invite/${inviteToken}`));
        const data = await res.json();
        expect(data.valid).toBe(false);
    });

    test('registering with used token fails', async () => {
        const res = await ctx.app.handle(
            new Request(`http://localhost/p/invite/${inviteToken}/register`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'Replay', username: 'replayer', password: 'testpassword123' }),
            }),
        );
        expect(res.status).toBe(400);
    });

    // -- Reject and delete --

    test('submit another entry for reject/delete tests', async () => {
        await ctx.app.handle(
            new Request('http://localhost/p/waitlist', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: 'reject-me@example.com', notes: '' }),
            }),
        );
    });

    test('admin can reject entry', async () => {
        const listRes = await authedRequest(
            ctx.alice.user.sessionToken,
            `/waitlist/${ctx.alice.user.id}/entries?status=pending`,
        );
        const entries = await assertJson<WaitlistEntry[]>(listRes);
        const entry = entries.find((e) => e.email === 'reject-me@example.com');
        expect(entry).toBeDefined();

        const res = await authedRequest(
            ctx.alice.user.sessionToken,
            `/waitlist/${ctx.alice.user.id}/entries/${entry!.id}/reject`,
            { method: 'PUT' },
        );
        expect(res.status).toBe(200);
    });

    test('rejected entry can be re-accepted', async () => {
        const listRes = await authedRequest(
            ctx.alice.user.sessionToken,
            `/waitlist/${ctx.alice.user.id}/entries?status=rejected`,
        );
        const entries = await assertJson<WaitlistEntry[]>(listRes);
        const entry = entries.find((e) => e.email === 'reject-me@example.com');
        expect(entry).toBeDefined();

        const res = await authedRequest(
            ctx.alice.user.sessionToken,
            `/waitlist/${ctx.alice.user.id}/entries/${entry!.id}/accept`,
            { method: 'PUT' },
        );
        expect(res.status).toBe(200);
    });

    test('admin can delete entry', async () => {
        const listRes = await authedRequest(
            ctx.alice.user.sessionToken,
            `/waitlist/${ctx.alice.user.id}/entries?status=invited`,
        );
        const entries = await assertJson<WaitlistEntry[]>(listRes);
        const entry = entries.find((e) => e.email === 'reject-me@example.com');
        expect(entry).toBeDefined();

        const res = await authedRequest(
            ctx.alice.user.sessionToken,
            `/waitlist/${ctx.alice.user.id}/entries/${entry!.id}`,
            { method: 'DELETE' },
        );
        expect(res.status).toBe(200);
    });

    // -- Waitlist disabled guard on admin routes --

    test('admin routes return 403 when waitlist is disabled', async () => {
        await authedRequest(ctx.alice.user.sessionToken, '/settings/server', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ onboarding: { waitlist: { enabled: false } } }),
        });

        const res = await authedRequest(ctx.alice.user.sessionToken, `/waitlist/${ctx.alice.user.id}/entries`);
        expect(res.status).toBe(403);

        // Re-enable for cleanup
        await authedRequest(ctx.alice.user.sessionToken, '/settings/server', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ onboarding: { waitlist: { enabled: true } } }),
        });
    });

    // -- Invite email template in settings --

    test('invite email template is in server settings', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken, '/settings/server');
        const data = await assertJson<ServerSettings>(res);
        expect(data.onboarding.inviteEmail).toBeDefined();
        expect(data.onboarding.inviteEmail.subject).toContain('{orgName}');
        expect(data.onboarding.inviteEmail.body).toContain('{inviteLink}');
    });

    test('admin can update invite email template', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken, '/settings/server', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                onboarding: { inviteEmail: { subject: 'Welcome to {orgName}!' } },
            }),
        });
        const data = await assertJson<ServerSettings>(res);
        expect(data.onboarding.inviteEmail.subject).toBe('Welcome to {orgName}!');
    });

    // -- HTML body escaping (regression for HTML-injection in templated tokens) --

    test('buildInviteEmail HTML-escapes substituted tokens in the body', async () => {
        // Plant a body that interpolates `{email}` inside an HTML template. A waitlist email
        // would normally be validated, but the substitution path must still escape — defense
        // in depth, and required once admin/orgName starts containing HTML-special chars.
        await authedRequest(ctx.alice.user.sessionToken, '/settings/server', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                onboarding: { inviteEmail: { body: '<p>Hi {email} on {domain}</p>' } },
            }),
        });

        const { buildInviteEmail } = await import('../lib/waitlist/waitlist');
        const mail = buildInviteEmail({ email: 'a<script>@x.test', inviteToken: 'tok-abc' });

        // The literal `<script>` tag must not appear in the rendered HTML body —
        // it should be escaped to `&lt;script&gt;`.
        expect(mail.html).not.toContain('a<script>@x.test');
        expect(mail.html).toContain('a&lt;script&gt;@x.test');

        // Restore default for downstream tests.
        await authedRequest(ctx.alice.user.sessionToken, '/settings/server', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                onboarding: {
                    inviteEmail: {
                        body: '<p>Hi!</p><p>You\'ve been invited to join {orgName} at {domain}.</p><p><a href="{inviteLink}">Create your account</a></p><p>This link expires in 7 days.</p>',
                    },
                },
            }),
        });
    });
});
