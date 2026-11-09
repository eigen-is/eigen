// The assignee's avatar on a card is muted like the rest of the footer, unless the card is open and assigned to the
// person looking at it: then it stands out in full color, ringed in the app's color. The server stores the assignee
// in lowercase, whatever case the account's email has. The unread dot leads the footer, also on a card with no replies
// yet, such as one you were just assigned.
import { expect, mock, test } from 'bun:test';
import { installHappyDom } from '../../happy-dom';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

const realAuth = await import('@workspace/lib/auth');
let email: string | null = 'Me@example.com';
mock.module('@workspace/lib/auth', () => ({
    ...realAuth,
    useAuth: () => ({ user: email ? { email } : null }),
}));
mock.module('../../../components/comments/member-avatar', () => ({
    MemberAvatar: ({ className }: { className?: string }) => <span data-testid="avatar" className={className} />,
}));

const { NoteCard } = await import('../../../components/notes/note-card');

async function avatarClasses(assigneeEmail: string, resolved = false) {
    const { container } = await renderInDocument(
        <NoteCard title="A card" assigneeEmail={assigneeEmail} resolved={resolved} />,
    );
    return container.querySelector('[data-testid="avatar"]')?.className ?? '';
}

test('a resolved card assigned to you is muted like any other, since nothing is left to do on it', async () => {
    email = 'me@example.com';
    const classes = await avatarClasses('me@example.com', true);
    expect(classes).toContain('opacity-50');
    expect(classes).not.toContain('ring-');
});

test('a card assigned to you shows the avatar unmuted, ringed in the app color', async () => {
    email = 'Me@example.com';
    const classes = await avatarClasses('me@example.com');
    expect(classes).toContain('ring-(--app-current-color)');
    expect(classes).not.toContain('opacity-50');
});

test("a card assigned to someone else keeps the avatar muted, and so does anyone's when signed out", async () => {
    email = 'me@example.com';
    const someoneElse = await avatarClasses('other@example.com');
    expect(someoneElse).toContain('opacity-50');
    expect(someoneElse).not.toContain('ring-');

    email = null;
    const signedOut = await avatarClasses('me@example.com');
    expect(signedOut).toContain('opacity-50');
    expect(signedOut).not.toContain('ring-');
});

test('the unread dot leads the footer, before the replies, and stays unmuted', async () => {
    const { container } = await renderInDocument(<NoteCard title="A card" unread replyCount={2} />);
    const footer = container.querySelector('p');
    expect(footer?.firstElementChild?.className).toContain('bg-destructive');
    expect(footer?.firstElementChild?.className).not.toContain('opacity-50');
    expect(footer?.firstElementChild?.className).not.toContain('absolute');
    expect(footer?.textContent).toBe('2 replies');
});

test('an unread card with no replies still shows the dot, and a read one has no footer', async () => {
    const unread = await renderInDocument(<NoteCard title="A card" unread />);
    expect(unread.container.querySelector('p > .bg-destructive')).not.toBeNull();
    const read = await renderInDocument(<NoteCard title="A card" />);
    expect(read.container.querySelector('p')).toBeNull();
});
