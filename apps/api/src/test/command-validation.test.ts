import {describe, test, expect} from 'bun:test';
import {validateCommand} from '@workspace/lib/validation';

describe('Command Validation', () => {
    describe('Valid Commands', () => {
        test('accepts built-in emotes', () => {
            expect(validateCommand('/dance')).toEqual({valid: true, kind: 'builtin-emote'});
            expect(validateCommand('/shrug')).toEqual({valid: true, kind: 'builtin-emote'});
            expect(validateCommand('/flip')).toEqual({valid: true, kind: 'builtin-emote'});
        });

        test('accepts help commands', () => {
            expect(validateCommand('/help')).toEqual({valid: true, kind: 'help'});
            expect(validateCommand('/h')).toEqual({valid: true, kind: 'help'});
            expect(validateCommand('/?')).toEqual({valid: true, kind: 'help'});
        });

        test('accepts time command', () => {
            expect(validateCommand('/time')).toEqual({valid: true, kind: 'time'});
        });

        test('accepts custom emote with action', () => {
            expect(validateCommand('/me dances')).toEqual({valid: true, kind: 'emote'});
            expect(validateCommand('/me waves hello')).toEqual({valid: true, kind: 'emote'});
        });

        test('accepts whisper with valid email and message', () => {
            expect(validateCommand('/whisper test@example.com hello there'))
                .toEqual({valid: true, kind: 'whisper'});
            expect(validateCommand('/w user@domain.com hi'))
                .toEqual({valid: true, kind: 'whisper'});
        });

        test('accepts reply with message', () => {
            expect(validateCommand('/reply hello back')).toEqual({valid: true, kind: 'reply'});
            expect(validateCommand('/r thanks')).toEqual({valid: true, kind: 'reply'});
        });

        test('accepts invite with valid email', () => {
            expect(validateCommand('/invite test@example.com'))
                .toEqual({valid: true, kind: 'invite'});
            expect(validateCommand('/i user@domain.com'))
                .toEqual({valid: true, kind: 'invite'});
        });

        test('accepts inspect with valid email', () => {
            expect(validateCommand('/inspect test@example.com'))
                .toEqual({valid: true, kind: 'inspect'});
            expect(validateCommand('/look user@domain.com'))
                .toEqual({valid: true, kind: 'inspect'});
        });
    });

    describe('Invalid Commands', () => {
        test('rejects non-slash commands', () => {
            expect(validateCommand('hello')).toEqual({
                valid: false,
                error: 'Command must start with /'
            });
        });

        test('rejects unknown commands', () => {
            expect(validateCommand('/unknown')).toEqual({
                valid: false,
                error: 'Unknown command: /unknown'
            });
            expect(validateCommand('/invalidcmd')).toEqual({
                valid: false,
                error: 'Unknown command: /invalidcmd'
            });
        });

        test('rejects custom emote without action', () => {
            expect(validateCommand('/me')).toEqual({
                valid: false,
                error: '/me requires an action description'
            });
            expect(validateCommand('/me   ')).toEqual({
                valid: false,
                error: '/me requires an action description'
            });
        });

        test('rejects whisper without email and message', () => {
            expect(validateCommand('/whisper')).toEqual({
                valid: false,
                error: '/whisper requires email and message'
            });
            expect(validateCommand('/w test@example.com')).toEqual({
                valid: false,
                error: '/w requires email and message'
            });
        });

        test('rejects whisper with invalid email', () => {
            expect(validateCommand('/whisper invalid-email hello')).toEqual({
                valid: false,
                error: "'invalid-email' is not a valid email address"
            });
            expect(validateCommand('/w @domain.com hi')).toEqual({
                valid: false,
                error: "'@domain.com' is not a valid email address"
            });
        });

        test('rejects reply without message', () => {
            expect(validateCommand('/reply')).toEqual({
                valid: false,
                error: '/reply requires a message'
            });
            expect(validateCommand('/r')).toEqual({
                valid: false,
                error: '/r requires a message'
            });
        });

        test('rejects invite without email', () => {
            expect(validateCommand('/invite')).toEqual({
                valid: false,
                error: 'invite target cannot be empty'
            });
            expect(validateCommand('/i   ')).toEqual({
                valid: false,
                error: 'invite target cannot be empty'
            });
        });

        test('rejects invite with invalid email', () => {
            expect(validateCommand('/invite invalid-email')).toEqual({
                valid: false,
                error: "'invalid-email' is not a valid email address"
            });
        });

        test('rejects inspect without email', () => {
            expect(validateCommand('/inspect')).toEqual({
                valid: false,
                error: 'inspect target cannot be empty'
            });
        });

        test('rejects inspect with invalid email', () => {
            expect(validateCommand('/look invalid-email')).toEqual({
                valid: false,
                error: "'invalid-email' is not a valid email address"
            });
        });
    });

    describe('Edge Cases', () => {
        test('handles whitespace correctly', () => {
            expect(validateCommand('  /dance  ')).toEqual({valid: true, kind: 'builtin-emote'});
            expect(validateCommand('\t/help\n')).toEqual({valid: true, kind: 'help'});
        });

        test('handles complex email addresses', () => {
            expect(validateCommand('/whisper user.name+tag@sub.domain.co.uk message'))
                .toEqual({valid: true, kind: 'whisper'});
        });

        test('handles messages with spaces', () => {
            expect(validateCommand('/whisper test@example.com this is a long message'))
                .toEqual({valid: true, kind: 'whisper'});
            expect(validateCommand('/me does something complicated'))
                .toEqual({valid: true, kind: 'emote'});
        });
    });
});
