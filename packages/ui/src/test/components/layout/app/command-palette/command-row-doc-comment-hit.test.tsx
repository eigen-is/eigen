// A comment hit's context line names who last spoke in the thread. The server sends an email, and the
// row shows the person's name from the user directory, or the email when the directory has no name.
import { afterAll, expect, mock, test } from 'bun:test';
import { installHappyDom } from '../../../../happy-dom';
import { renderInDocument } from '../../../../render-in-document';

installHappyDom();

// Signed out, so the contacts query stays off and the name comes from the user directory alone.
const realAuth = { ...(await import('@workspace/lib/auth')) };
mock.module('@workspace/lib/auth', () => ({ ...realAuth, useAuth: () => ({ user: null }), useIsGuest: () => false }));
const directory: Record<string, { data: { name: string }; isLoading: false }> = {
    'dana@example.com': { data: { name: 'Dana Quillfeather' }, isLoading: false },
};
const notInDirectory = { data: null, isLoading: false };
const realPublic = { ...(await import('@workspace/lib/public')) };
mock.module('@workspace/lib/public', () => ({
    ...realPublic,
    usePublicUser: (email: string) => directory[email] ?? notInDirectory,
}));

afterAll(() => {
    mock.module('@workspace/lib/auth', () => realAuth);
    mock.module('@workspace/lib/public', () => realPublic);
});

const { createElement } = await import('react');
const { MessageSquareText } = await import('lucide-react');
const { Command, CommandList } = await import('../../../../../components/command');
const { CommandRowDocCommentHit } = await import(
    '../../../../../components/layout/app/command-palette/command-row-doc-comment-hit'
);

async function contextLine(context: string | undefined): Promise<string[]> {
    const result = {
        kind: 'doc-comment-hit' as const,
        id: 'doc-comment.thread-1',
        title: 'the pineapple roadmap',
        icon: MessageSquareText,
        group: 'doc-comments' as const,
        rank: 0,
        payload: { id: 'thread-1', label: 'the pineapple roadmap', context },
        run: () => {},
    };
    const row = createElement(CommandRowDocCommentHit, { result, onSelect: () => {} });
    const { container, unmount } = await renderInDocument(
        createElement(Command, null, createElement(CommandList, null, row)),
    );
    const lines = [...container.querySelectorAll('[cmdk-item] .text-xs')].map((line) => line.textContent ?? '');
    await unmount();
    return lines;
}

test('the last author shows by name, not by email', async () => {
    expect(await contextLine('dana@example.com')).toEqual(['Dana Quillfeather']);
});

test('an author the directory has no name for shows by email', async () => {
    expect(await contextLine('stranger@example.com')).toEqual(['stranger@example.com']);
});

test('a hit with no last author has no context line', async () => {
    expect(await contextLine(undefined)).toEqual([]);
});
