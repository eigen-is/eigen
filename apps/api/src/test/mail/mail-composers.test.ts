import { describe, expect, test } from 'bun:test';
import type { DrivePath } from '@workspace/lib/types/drive';
import {
    composeAccessRequestEmail,
    composeCollaboratorsEmail,
    composeInviteEmail,
    composeOtpEmail,
    composeShareEmail,
} from '../../lib/core/mail-composers';

const PATH: DrivePath = {
    id: 'p1',
    mountId: 'm1',
    ownerId: 'u-owner',
    name: 'Quarterly Plan.eigendoc',
    type: 'doc',
    parentId: null,
    mimeType: 'application/eigendoc',
    size: 0,
    hash: null,
    thumbnail: null,
    acl: null,
    visibility: 'private',
    sharingRestricted: false,
    details: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    trashedAt: null,
};

describe('composeShareEmail', () => {
    test('subject and HTML mention the actor and stripped file name', () => {
        const mail = composeShareEmail(PATH, 'bob@test.eigen.is', { name: 'Alice', email: 'alice@test.eigen.is' });
        expect(mail.to[0].address).toBe('bob@test.eigen.is');
        expect(mail.subject).toContain('Alice');
        expect(mail.subject).toContain('Quarterly Plan');
        expect(mail.html).toContain('Quarterly Plan');
        expect(mail.html).not.toContain('.eigendoc'); // extension stripped in display
        expect(mail.text).toContain('Alice');
        expect(mail.from?.address).toBe('alice@test.eigen.is');
    });
});

describe('composeAccessRequestEmail', () => {
    test('subject mentions requester and path; body includes optional message', () => {
        const mail = composeAccessRequestEmail(
            PATH,
            { name: 'Owner', email: 'owner@test.eigen.is' },
            { name: 'Bob', email: 'bob@test.eigen.is' },
            'I need this for the report',
        );
        expect(mail.to[0].address).toBe('owner@test.eigen.is');
        expect(mail.subject).toContain('Bob');
        expect(mail.subject).toContain('Quarterly Plan');
        expect(mail.html).toContain('I need this for the report');
        expect(mail.from?.address).toBe('bob@test.eigen.is'); // sender = requester
    });

    test('omits message block when message is null', () => {
        const mail = composeAccessRequestEmail(
            PATH,
            { name: 'Owner', email: 'owner@test.eigen.is' },
            { name: 'Bob', email: 'bob@test.eigen.is' },
            null,
        );
        expect(mail.html).not.toContain('I need');
        expect(mail.html).toContain('Bob'); // still mentions requester
    });
});

describe('composeCollaboratorsEmail', () => {
    test('embeds user-typed HTML and attaches the path link', () => {
        const mail = composeCollaboratorsEmail(
            PATH,
            null,
            '<p>Hi team</p>',
            { name: 'Alice', email: 'alice@test.eigen.is' },
            'bob@test.eigen.is',
        );
        expect(mail.to[0].address).toBe('bob@test.eigen.is');
        expect(mail.subject).toBe('Quarterly Plan'); // falls back to doc name when subject is null
        expect(mail.html).toContain('<p>Hi team</p>');
        expect(mail.html).toContain('Quarterly Plan');
        expect(mail.text).toContain('Hi team');
        // Plain-text falls back to the path-derived URL — same as the HTML pill.
        expect(mail.text).toMatch(/\/doc\/u-owner\/m1\/p1/);
        expect(mail.from?.address).toBe('alice@test.eigen.is');
    });

    test('uses custom subject when provided', () => {
        const mail = composeCollaboratorsEmail(
            PATH,
            'Quick review needed',
            '<p>Hi team</p>',
            { name: 'Alice', email: 'alice@test.eigen.is' },
            'bob@test.eigen.is',
        );
        expect(mail.subject).toBe('Quick review needed');
        expect(mail.html).toContain('Quick review needed');
    });

    test('falls back to doc name for whitespace-only subject', () => {
        const mail = composeCollaboratorsEmail(
            PATH,
            '   ',
            '<p>Hi team</p>',
            { name: 'Alice', email: 'alice@test.eigen.is' },
            'bob@test.eigen.is',
        );
        expect(mail.subject).toBe('Quarterly Plan');
    });
});

describe('composeOtpEmail', () => {
    test('2fa: subject names a code and the domain-bound trailer pins iOS AutoFill to this site', () => {
        const mail = composeOtpEmail(
            { name: 'Alice', email: 'alice@test.eigen.is' },
            '123456',
            '2fa',
            'Acme',
            'acme.example.com',
        );
        expect(mail.subject).toBe('Your verification code');
        expect(mail.html).toContain('123456');
        expect(mail.text).toContain('123456');
        // iOS Security Code AutoFill domain-bound trailer
        expect(mail.text).toContain('@acme.example.com #123456');
        // Branded shell: footer line carries org name
        expect(mail.html).toContain('Acme');
    });

    test('guest: distinct subject and intro copy', () => {
        const mail = composeOtpEmail(
            { name: 'guest@example.com', email: 'guest@example.com' },
            '654321',
            'guest',
            'Acme',
            'acme.example.com',
        );
        expect(mail.subject).toBe('Your guest access code');
        expect(mail.text).toContain('shared documents');
    });

    test('omits domain trailer when running on localhost', () => {
        const mail = composeOtpEmail({ name: 'a', email: 'a@b.test' }, '111111', '2fa', 'Acme', 'localhost');
        expect(mail.text).not.toContain('@localhost');
        expect(mail.text).not.toContain('#111111');
    });

    test('omits domain trailer when domain undefined', () => {
        const mail = composeOtpEmail({ name: 'a', email: 'a@b.test' }, '222222', 'guest', 'Acme');
        expect(mail.text).not.toContain(' #222222');
    });
});

describe('composeInviteEmail', () => {
    test('wraps admin-authored body in branded shell; recipient email passed for guest pill links', () => {
        const mail = composeInviteEmail(
            'newuser@example.com',
            "You're invited to Acme",
            '<p>Hi!</p><p><a href="https://acme.example.com/space/signup?token=abc">Create your account</a></p>',
            'Acme',
        );
        expect(mail.subject).toBe("You're invited to Acme");
        expect(mail.to[0].address).toBe('newuser@example.com');
        // Title is HTML-escaped in the shell — apostrophe becomes &#39;
        expect(mail.html).toContain('invited to Acme');
        expect(mail.html).toContain('Create your account');
        expect(mail.html).toContain('Acme'); // footer
        expect(mail.text).toContain('Create your account');
        expect(mail.text).not.toContain('<p>');
    });
});
