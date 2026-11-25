// A card is you when it carries your account's id or your email, in any case and with stray spaces, and
// every contact surface asks the same question before it offers Delete, mail or chat. Assign label is a set of
// toggles, so the menu stays open after one and a second label is one click away.
import { afterAll, expect, mock, test } from 'bun:test';
import type { AuthUser } from '@workspace/lib/types/auth';
import type { Contact } from '@workspace/lib/types/contact';
import { installHappyDom } from '@workspace/ui/test/happy-dom';

// The rule shares a file with the menu, which loads Radix: the later files get it as it loads here.
installHappyDom();

// A copy, because mock.module rewrites a loaded module's exports in place, and afterAll puts the original back.
const realAuth = { ...(await import('@workspace/lib/auth')) };
mock.module('@workspace/lib/auth', () => ({ ...realAuth, useAuth: () => ({ user: null }) }));
afterAll(() => {
    mock.module('@workspace/lib/auth', () => realAuth);
});

const { createElement } = await import('react');
const { clickRow, openSubmenu, renderOpenMenu } = await import('@workspace/ui/test/menu-rows');
const { isSelfContact, useContactMenu } = await import('../../../components/contacts/contact-menu');

const user: AuthUser = {
    id: 'u1',
    email: 'me@test.eigen.is',
    name: 'Me',
    emailVerified: true,
    createdAt: new Date('2026-10-01'),
    updatedAt: new Date('2026-10-01'),
};
const card = (p: Partial<Contact>): Contact => ({
    id: 'c1',
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: [],
    phone: [],
    etag: 'e1',
    ...p,
});

test('a card linked to your account is you, whatever its emails', () => {
    expect(isSelfContact(card({ eigenId: 'u1' }), user)).toBe(true);
});

test('a card with your email is you, in any case and with spaces around it', () => {
    expect(isSelfContact(card({ email: ['ada@example.com', '  ME@Test.Eigen.is '] }), user)).toBe(true);
});

test("someone else's card is not you", () => {
    expect(isSelfContact(card({ eigenId: 'u2', email: ['ada@example.com'] }), user)).toBe(false);
});

test('signed out, or with no email of your own, no card is you, not even a blank one', () => {
    expect(isSelfContact(card({ email: [''] }), null)).toBe(false);
    expect(isSelfContact(card({ email: ['', ' '] }), { ...user, email: '' })).toBe(false);
});

test('a label toggle leaves the menu open', async () => {
    const toggled: string[] = [];
    const close = mock(() => {});
    function Menu() {
        return useContactMenu().renderItems([card({})], close, {
            labels: [{ id: 'work', name: 'Work', color: '#888888' }],
            onToggleLabel: (_contacts, labelId) => toggled.push(labelId),
        });
    }
    const { unmount } = await renderOpenMenu(createElement(Menu));
    await openSubmenu('Assign label');
    await clickRow('Work');
    expect(toggled).toEqual(['work']);
    expect(close).not.toHaveBeenCalled();
    await unmount();
});
