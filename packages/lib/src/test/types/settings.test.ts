import { describe, expect, test } from 'bun:test';
import { isUserTheme, themeOf } from '../../types/settings';

describe('themeOf', () => {
    test('reads the theme the user saved', () => {
        expect(themeOf({ theme: 'dark' })).toBe('dark');
        expect(themeOf({ theme: 'system' })).toBe('system');
    });

    test('is Light for a user who never picked one, or before the settings load', () => {
        expect(themeOf({})).toBe('light');
        expect(themeOf(undefined)).toBe('light');
    });
});

describe('isUserTheme', () => {
    test('accepts the three themes and nothing else', () => {
        expect(['light', 'dark', 'system'].every(isUserTheme)).toBe(true);
        expect(isUserTheme('sepia')).toBe(false);
        expect(isUserTheme('')).toBe(false);
    });
});
