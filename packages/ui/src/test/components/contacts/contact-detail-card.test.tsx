// The subtitle under a contact's name shows the job title, with the company when there is one. The card's sections sit
// under small-caps captions, as every detail's body does.
import { expect, mock, test } from 'bun:test';
import type { Contact } from '@workspace/lib/types/contact';
import { installHappyDom } from '../../happy-dom';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

const realAuth = await import('@workspace/lib/auth');
mock.module('@workspace/lib/auth', () => ({ ...realAuth, useAuth: () => ({ user: null }), useIsGuest: () => false }));
const realContacts = await import('@workspace/lib/contacts');
mock.module('@workspace/lib/contacts', () => ({ ...realContacts, useContacts: () => ({ contacts: [] }) }));

const { createElement } = await import('react');
const { ContactDetailCard } = await import('../../../components/user/contact-detail-card');

const base: Contact = {
    id: 'c1',
    etag: 'e1',
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: ['ada@example.com'],
    phone: [],
};

async function subtitleOf(contact: Contact) {
    const { container, unmount } = await renderInDocument(createElement(ContactDetailCard, { contact, labels: [] }));
    const subtitle = container.querySelector('p.text-muted-foreground')?.textContent ?? null;
    await unmount();
    return subtitle;
}

test('a job title without a company is the subtitle', async () => {
    expect(await subtitleOf({ ...base, jobTitle: 'Engineer' })).toBe('Engineer');
});

test('a job title with a company reads "Job title at Company"', async () => {
    expect(await subtitleOf({ ...base, jobTitle: 'Engineer', company: 'Acme' })).toBe('Engineer at Acme');
});

test('a company without a job title adds no subtitle', async () => {
    expect(await subtitleOf({ ...base, company: 'Acme' })).toBeNull();
});

test('each section sits under a caption, as in every detail', async () => {
    const contact = { ...base, address: [{ city: 'London' }], notes: 'Met at the Analytical Society' };
    const { container, unmount } = await renderInDocument(createElement(ContactDetailCard, { contact, labels: [] }));
    const captions = [...container.querySelectorAll('h3')].map((h) => [h.textContent, h.className]);
    await unmount();
    expect(captions).toEqual([
        ['Contact information', 'eigen-section-label mb-2'],
        ['Addresses', 'eigen-section-label mb-2'],
        ['Notes', 'eigen-section-label mb-2'],
    ]);
});
