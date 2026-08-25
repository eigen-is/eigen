import { describe, expect, test } from 'bun:test';
import { validateCommand } from '../../validation';

describe('Command Validation', () => {
    describe('Valid Commands', () => {
        test('accepts built-in emotes', () => {
            expect(validateCommand('/dance')).toEqual({ valid: true, kind: 'builtin-emote' });
            expect(validateCommand('/shrug')).toEqual({ valid: true, kind: 'builtin-emote' });
            expect(validateCommand('/flip')).toEqual({ valid: true, kind: 'builtin-emote' });
        });

        test('accepts emote aliases', () => {
            expect(validateCommand('/lol')).toEqual({ valid: true, kind: 'builtin-emote' });
            expect(validateCommand('/hi')).toEqual({ valid: true, kind: 'builtin-emote' });
            expect(validateCommand('/sorry')).toEqual({ valid: true, kind: 'builtin-emote' });
            expect(validateCommand('/doom')).toEqual({ valid: true, kind: 'builtin-emote' });
        });

        test('accepts targeted emotes', () => {
            expect(validateCommand('/bow test@example.com')).toEqual({ valid: true, kind: 'builtin-emote' });
            expect(validateCommand('/laugh user@domain.com')).toEqual({ valid: true, kind: 'builtin-emote' });
        });

        test('accepts trout with valid email', () => {
            expect(validateCommand('/trout test@example.com')).toEqual({ valid: true, kind: 'builtin-emote' });
        });

        test('accepts help command', () => {
            expect(validateCommand('/help')).toEqual({ valid: true, kind: 'help' });
        });

        test('accepts custom emote with action', () => {
            expect(validateCommand('/me dances')).toEqual({ valid: true, kind: 'emote' });
            expect(validateCommand('/me waves hello')).toEqual({ valid: true, kind: 'emote' });
        });

        test('accepts whisper with valid email and message', () => {
            expect(validateCommand('/whisper test@example.com hello there')).toEqual({ valid: true, kind: 'whisper' });
            expect(validateCommand('/tell user@domain.com hi')).toEqual({ valid: true, kind: 'whisper' });
        });

        test('accepts reply with message', () => {
            expect(validateCommand('/reply hello back')).toEqual({ valid: true, kind: 'reply' });
        });

        test('accepts invite with valid email', () => {
            expect(validateCommand('/invite test@example.com')).toEqual({ valid: true, kind: 'invite' });
        });

        test('accepts inspect with valid email', () => {
            expect(validateCommand('/inspect test@example.com')).toEqual({ valid: true, kind: 'inspect' });
            expect(validateCommand('/look user@domain.com')).toEqual({ valid: true, kind: 'inspect' });
        });

        test('accepts whoami', () => {
            expect(validateCommand('/whoami')).toEqual({ valid: true, kind: 'whoami' });
        });

        test('accepts hide emote', () => {
            expect(validateCommand('/hide')).toEqual({ valid: true, kind: 'builtin-emote' });
            expect(validateCommand('/hide test@example.com')).toEqual({ valid: true, kind: 'builtin-emote' });
        });
    });

    describe('Invalid Commands', () => {
        test('rejects non-slash commands', () => {
            expect(validateCommand('hello')).toEqual({
                valid: false,
                error: 'Command must start with /',
            });
        });

        test('rejects unknown commands', () => {
            expect(validateCommand('/unknown')).toEqual({
                valid: false,
                error: 'Unknown command: /unknown',
            });
            expect(validateCommand('/invalidcmd')).toEqual({
                valid: false,
                error: 'Unknown command: /invalidcmd',
            });
        });

        test('rejects custom emote without action', () => {
            expect(validateCommand('/me')).toEqual({
                valid: false,
                error: '/me requires an action description',
            });
            expect(validateCommand('/me   ')).toEqual({
                valid: false,
                error: '/me requires an action description',
            });
        });

        test('rejects whisper without email and message', () => {
            expect(validateCommand('/whisper')).toEqual({
                valid: false,
                error: '/whisper requires email and message',
            });
            expect(validateCommand('/tell test@example.com')).toEqual({
                valid: false,
                error: '/tell requires email and message',
            });
        });

        test('rejects whisper with invalid email', () => {
            expect(validateCommand('/whisper invalid-email hello')).toEqual({
                valid: false,
                error: "'invalid-email' is not a valid email address",
            });
        });

        test('rejects reply without message', () => {
            expect(validateCommand('/reply')).toEqual({
                valid: false,
                error: '/reply requires a message',
            });
        });

        test('rejects invite without email', () => {
            expect(validateCommand('/invite')).toEqual({
                valid: false,
                error: 'invite target cannot be empty',
            });
        });

        test('rejects invite with invalid email', () => {
            expect(validateCommand('/invite invalid-email')).toEqual({
                valid: false,
                error: "'invalid-email' is not a valid email address",
            });
        });

        test('rejects inspect without email', () => {
            expect(validateCommand('/inspect')).toEqual({
                valid: false,
                error: 'inspect target cannot be empty',
            });
        });

        test('rejects inspect with invalid email', () => {
            expect(validateCommand('/look invalid-email')).toEqual({
                valid: false,
                error: "'invalid-email' is not a valid email address",
            });
        });

        test('rejects trout without target', () => {
            expect(validateCommand('/trout')).toEqual({
                valid: false,
                error: '/trout requires a target',
            });
        });

        test('rejects trout with invalid email', () => {
            expect(validateCommand('/trout invalid-email')).toEqual({
                valid: false,
                error: "'invalid-email' is not a valid email address",
            });
        });

        test('rejects targeted emote with invalid email', () => {
            expect(validateCommand('/bow not-an-email')).toEqual({
                valid: false,
                error: "'not-an-email' is not a valid email address",
            });
        });

        test('rejects whoami with a target', () => {
            expect(validateCommand('/whoami test@example.com')).toEqual({
                valid: false,
                error: '/whoami does not accept a target',
            });
        });

        test('rejects target on emotes that do not support targeting', () => {
            expect(validateCommand('/idea test@example.com')).toEqual({
                valid: false,
                error: '/idea does not accept a target',
            });
            expect(validateCommand('/flip test@example.com')).toEqual({
                valid: false,
                error: '/flip does not accept a target',
            });
        });
    });

    describe('Edge Cases', () => {
        test('handles whitespace correctly', () => {
            expect(validateCommand('  /dance  ')).toEqual({ valid: true, kind: 'builtin-emote' });
            expect(validateCommand('\t/help\n')).toEqual({ valid: true, kind: 'help' });
        });

        test('handles complex email addresses', () => {
            expect(validateCommand('/whisper user.name+tag@sub.domain.co.uk message')).toEqual({
                valid: true,
                kind: 'whisper',
            });
        });

        test('handles messages with spaces', () => {
            expect(validateCommand('/whisper test@example.com this is a long message')).toEqual({
                valid: true,
                kind: 'whisper',
            });
            expect(validateCommand('/me does something complicated')).toEqual({ valid: true, kind: 'emote' });
        });
    });
});
