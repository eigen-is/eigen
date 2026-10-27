// A card is you when it carries your account's id or your email, in any case and with stray spaces, and
// every contact surface asks the same question before it offers Delete, mail or chat.
import { expect, test } from 'bun:test';
import type { AuthUser } from '@workspace/lib/auth';
import type { Contact } from '@workspace/lib/types/contact';
import { installHappyDom } from '@workspace/ui/test/happy-dom';

// The rule shares a file with the menu, which loads Radix: the later files get it as it loads here.
installHappyDom();

const { isSelfContact } = await import('../../../components/contacts/contact-menu');

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
