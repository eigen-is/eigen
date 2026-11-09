import { describe, expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import { EIGEN_DOC_TYPE_INFO } from '@workspace/lib/types/drive';
import { driveKeys } from '../../../../core/drive/hooks/keys';
import { homeKeys } from '../../../../core/home/hooks/keys';
import type { DrivePath } from '../../../../types/drive';
import { renderHook } from '../../../render-hook';
import { installTransferHarness, OWNER as USER } from '../../../transfer-harness';

installTransferHarness();

const { useChatSections } = await import('../../../../core/chat/hooks/use-chat');

function chat(id: string, ownerId: string): DrivePath {
    return { id, ownerId } as DrivePath;
}

// The sections useChatSections builds from a cached chat list and team list.
async function groupChatsBySection(chats: DrivePath[], teams: { id: string; name: string }[]) {
    const queryClient = new QueryClient();
    queryClient.setQueryData(driveKeys.mimeAll(EIGEN_DOC_TYPE_INFO.chat.urlSlug), chats);
    queryClient.setQueryData(homeKeys.myTeams(USER), teams);
    const { latest, unmount } = await renderHook(() => useChatSections(), queryClient);
    await unmount();
    const { personal, teams: teamSections } = latest;
    return { personal, teams: teamSections };
}

describe('useChatSections', () => {
    test('separates personal chats from team chats, preserving order', async () => {
        const result = await groupChatsBySection(
            [chat('a', USER), chat('b', 'team_x'), chat('c', USER)],
            [{ id: 'x', name: 'Team X' }],
        );
        expect(result.personal.map((c) => c.id)).toEqual(['a', 'c']);
        expect(result.teams).toEqual([{ id: 'x', name: 'Team X', chats: [chat('b', 'team_x')] }]);
    });

    test('chats shared by other users (foreign non-team owner) land in personal, never dropped', async () => {
        const result = await groupChatsBySection(
            [chat('own', USER), chat('shared', 'user-2'), chat('t', 'team_x')],
            [{ id: 'x', name: 'Team X' }],
        );
        expect(result.personal.map((c) => c.id)).toEqual(['own', 'shared']);
        expect(result.teams[0].chats.map((c) => c.id)).toEqual(['t']);
    });

    test('groups team chats by owner in useMyTeams order, not chat order', async () => {
        const result = await groupChatsBySection(
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

    test('omits teams that have no chats', async () => {
        const result = await groupChatsBySection(
            [chat('a', 'team_a')],
            [
                { id: 'a', name: 'Team A' },
                { id: 'z', name: 'Team Z' },
            ],
        );
        expect(result.teams.map((t) => t.id)).toEqual(['a']);
    });

    test('empty input yields empty sections', async () => {
        expect(await groupChatsBySection([], [])).toEqual({ personal: [], teams: [] });
    });
});
