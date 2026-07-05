import { describe, expect, test } from 'bun:test';
import { formatEmoteForViewer } from '../lib/chat/commands';

const alice = { id: 'user-alice', email: 'alice@eigen.is' };
const bob = { id: 'user-bob', email: 'bob@eigen.is' };

describe('formatEmoteForViewer', () => {
    test('untargeted emote, third-person viewer sees the author email', () => {
        const out = formatEmoteForViewer('$cheer', alice.email, alice.id, bob.id, bob.email);
        expect(out).toBe('alice@eigen.is cheers enthusiastically!');
    });

    test('untargeted emote, author sees first-person', () => {
        const out = formatEmoteForViewer('$cheer', alice.email, alice.id, alice.id, alice.email);
        expect(out).toBe('You cheer enthusiastically!');
    });

    test('targeted emote, uninvolved viewer sees both emails', () => {
        const out = formatEmoteForViewer('$cheer:bob@eigen.is', alice.email, alice.id, 'user-carol', 'carol@eigen.is');
        expect(out).toBe('alice@eigen.is cheers at bob@eigen.is.');
    });

    test('targeted emote, the target sees the author email second-person', () => {
        const out = formatEmoteForViewer('$cheer:bob@eigen.is', alice.email, alice.id, bob.id, bob.email);
        expect(out).toBe('alice@eigen.is cheers at you.');
    });

    test('targeted emote, author sees the target email first-person', () => {
        const out = formatEmoteForViewer('$cheer:bob@eigen.is', alice.email, alice.id, alice.id, alice.email);
        expect(out).toBe('You cheer at bob@eigen.is.');
    });

    test('custom /me emote prefixes the author email', () => {
        const out = formatEmoteForViewer('waves a flag', alice.email, alice.id, bob.id, bob.email);
        expect(out).toBe('alice@eigen.is waves a flag');
    });
});
