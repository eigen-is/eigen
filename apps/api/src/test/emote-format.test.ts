import { describe, expect, test } from 'bun:test';
import { formatChatPreview } from '@workspace/lib/chat/format-preview';
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

// The activity-preview sibling of formatEmoteForViewer: same emote phrasing, but the
// surrounding row names the actor, so it drops the actor prefix and resolves emails to names.
describe('formatChatPreview', () => {
    const resolveName = (email: string): string | undefined =>
        ({ 'marloes@eigen.is': 'Marloes Robijn', 'bob@eigen.is': 'Bob Jones' })[email];

    test('untargeted emote → actor-stripped third-person sentence', () => {
        expect(formatChatPreview('$dance')).toBe('dances around the room.');
    });

    test('targeted emote resolves the target email to a name', () => {
        expect(formatChatPreview('$dance:marloes@eigen.is', { resolveName })).toBe('dances with Marloes Robijn.');
    });

    test('targeted emote keeps the raw email when no resolver is given', () => {
        expect(formatChatPreview('$dance:marloes@eigen.is')).toBe('dances with marloes@eigen.is.');
    });

    test('viewer is the target → second-person "you"', () => {
        expect(formatChatPreview('$dance:marloes@eigen.is', { resolveName, viewerEmail: 'marloes@eigen.is' })).toBe(
            'dances with you.',
        );
    });

    test('possessive {name} phrasing drops the actor gracefully', () => {
        expect(formatChatPreview('$smirk')).toBe('A sly smirk spreads across their face.');
    });

    test('plain message resolves bare emails to names', () => {
        expect(formatChatPreview('Hi marloes@eigen.is', { resolveName })).toBe('Hi Marloes Robijn');
    });

    test('plain message stays raw without a resolver', () => {
        expect(formatChatPreview('Hi marloes@eigen.is')).toBe('Hi marloes@eigen.is');
    });

    test('mixed text resolves every email occurrence', () => {
        expect(formatChatPreview('ping marloes@eigen.is and bob@eigen.is', { resolveName })).toBe(
            'ping Marloes Robijn and Bob Jones',
        );
    });

    test('custom /me emote (no $) leaves the actor to the row, resolves emails', () => {
        expect(formatChatPreview('waves at bob@eigen.is', { resolveName })).toBe('waves at Bob Jones');
    });

    test('plain message that merely starts with $ is not treated as an emote', () => {
        expect(formatChatPreview('$5 for coffee bob@eigen.is', { resolveName })).toBe('$5 for coffee Bob Jones');
    });
});
