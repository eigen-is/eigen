import { describe, expect, test } from 'bun:test';
import { groupChatsBySection } from '../../../../core/chat/hooks/use-chat';
import type { DrivePath } from '../../../../types/drive';

const USER = 'user-1';

function chat(id: string, ownerId: string): DrivePath {
    return { id, ownerId } as DrivePath;
}

describe('groupChatsBySection', () => {
    test('separates personal chats from team chats, preserving order', () => {
        const result = groupChatsBySection(
            [chat('a', USER), chat('b', 'team_x'), chat('c', USER)],
            [{ id: 'x', name: 'Team X' }],
        );
        expect(result.personal.map((c) => c.id)).toEqual(['a', 'c']);
        expect(result.teams).toEqual([{ id: 'x', name: 'Team X', chats: [chat('b', 'team_x')] }]);
    });

    test('chats shared by other users (foreign non-team owner) land in personal, never dropped', () => {
        const result = groupChatsBySection(
            [chat('own', USER), chat('shared', 'user-2'), chat('t', 'team_x')],
            [{ id: 'x', name: 'Team X' }],
        );
        expect(result.personal.map((c) => c.id)).toEqual(['own', 'shared']);
        expect(result.teams[0].chats.map((c) => c.id)).toEqual(['t']);
    });

    test('groups team chats by owner in useMyTeams order, not chat order', () => {
        const result = groupChatsBySection(
            [chat('b1', 'team_b'), chat('a1', 'team_a'), chat('b2', 'team_b')],
            [
                { id: 'a', name: 'Team A' },
                { id: 'b', name: 'Team B' },
            ],
        );
        expect(result.teams.map((t) => t.id)).toEqual(['a', 'b']);
        expect(result.teams[0].chats.map((c) => c.id)).toEqual(['a1']);
        expect(result.teams[1].chats.map((c) => c.id)).toEqual(['b1', 'b2']);
    });

    test('omits teams that have no chats', () => {
        const result = groupChatsBySection(
            [chat('a', 'team_a')],
            [
                { id: 'a', name: 'Team A' },
                { id: 'z', name: 'Team Z' },
            ],
        );
        expect(result.teams.map((t) => t.id)).toEqual(['a']);
    });

    test('empty input yields empty sections', () => {
        expect(groupChatsBySection([], [])).toEqual({ personal: [], teams: [] });
    });
});
