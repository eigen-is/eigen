import { describe, expect, test } from 'bun:test';
import type { DrivePath } from '../../../types/drive';
import { combineTeamChats } from './use-chat';

function chat(id: string): DrivePath {
    return { id } as DrivePath;
}

describe('combineTeamChats', () => {
    test('flattens team chat lists in team order', () => {
        const result = combineTeamChats([
            { data: [chat('a'), chat('b')], isLoading: false },
            { data: [chat('c')], isLoading: false },
        ]);
        expect(result.chats.map((c) => c.id)).toEqual(['a', 'b', 'c']);
        expect(result.isLoading).toBe(false);
    });

    test('treats missing data as an empty list', () => {
        const result = combineTeamChats([
            { data: undefined, isLoading: false },
            { data: [chat('a')], isLoading: false },
        ]);
        expect(result.chats.map((c) => c.id)).toEqual(['a']);
    });

    test('is loading while any team query is still loading', () => {
        const result = combineTeamChats([
            { data: [chat('a')], isLoading: false },
            { data: undefined, isLoading: true },
        ]);
        expect(result.isLoading).toBe(true);
    });

    test('empty input is settled and empty', () => {
        expect(combineTeamChats([])).toEqual({ chats: [], isLoading: false });
    });
});
