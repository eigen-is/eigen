import { describe, expect, test } from 'bun:test';
import type { DrivePath } from '@workspace/lib/types/drive';
import { composeAccessRequestEmail, composeCollaboratorsEmail, composeShareEmail } from '../lib/core/mail-composers';

const PATH: DrivePath = {
    id: 'p1',
    mountId: 'm1',
    ownerId: 'u-owner',
    name: 'Quarterly Plan.eigendoc',
    type: 'file',
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
            '<p>Hi team</p>',
            'https://test.eigen.is/docs/doc/u-owner/m1/p1',
            { name: 'Alice', email: 'alice@test.eigen.is' },
            'bob@test.eigen.is',
        );
        expect(mail.to[0].address).toBe('bob@test.eigen.is');
        expect(mail.html).toContain('<p>Hi team</p>');
        expect(mail.html).toContain('Quarterly Plan');
        expect(mail.text).toContain('Hi team');
        expect(mail.text).toContain('https://test.eigen.is/docs/doc/u-owner/m1/p1');
        expect(mail.from?.address).toBe('alice@test.eigen.is');
    });
});
