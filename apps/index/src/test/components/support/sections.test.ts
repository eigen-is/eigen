import { describe, expect, test } from 'bun:test';
import { getSection } from '../../../components/support/sections';

describe('help center section colors', () => {
    test('an app section wears its app color', () => {
        expect(getSection('mail')?.color).toBe('var(--app-mail-color)');
        expect(getSection('sheets')?.color).toBe('var(--app-sheets-color)');
        expect(getSection('contacts')?.color).toBe('var(--app-contacts-color)');
    });

    test('the Admin section wears the admin color', () => {
        expect(getSection('admin')?.color).toBe('var(--app-admin-color)');
    });

    test('a section tied to no app keeps the help center teal', () => {
        for (const id of ['getting-started', 'connect', 'account', 'self-hosting']) {
            expect(getSection(id)?.color).toBe('var(--app-current-color)');
        }
    });
});
