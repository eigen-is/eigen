// A `?chat=` landing opens its card only once the host is ready, so it never opens a card in a state the host is
// about to change. A name no card holds by then is reported once.
import { expect, mock, test } from 'bun:test';
import type { CommentCard } from '../../../../types/comments';
import { installHappyDom } from '../../../happy-dom';

// react-dom needs a DOM to render the hook into.
installHappyDom();

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { useCardIdFromChatName } = await import('../../../../core/comments/hooks/use-card-id-from-chat-name');

const cards: Record<string, CommentCard> = {
    'card-1': { id: 'card-1', title: 'Check this', description: '', chatName: 'thread-1.eigenchat' },
};

async function mountLanding(chatName: string) {
    const opened = mock((_cardId: string) => {});
    const notFound = mock(() => {});
    const root = createRoot(document.createElement('div'));
    function Harness({ ready }: { ready: boolean }) {
        useCardIdFromChatName(cards, chatName, opened, { ready, onChatNotFound: notFound });
        return null;
    }
    const render = (ready: boolean) =>
        act(async () => {
            root.render(<Harness ready={ready} />);
        });
    return { opened, notFound, render, unmount: () => act(() => root.unmount()) };
}

test('a landing waits for the host to be ready, then opens its card once', async () => {
    const landing = await mountLanding('thread-1.eigenchat');
    await landing.render(false);
    expect(landing.opened).not.toHaveBeenCalled();
    await landing.render(true);
    await landing.render(true);
    expect(landing.opened.mock.calls).toEqual([['card-1']]);
    expect(landing.notFound).not.toHaveBeenCalled();
    await landing.unmount();
});

test('a name no card holds is reported once the host is ready', async () => {
    const landing = await mountLanding('gone.eigenchat');
    await landing.render(false);
    expect(landing.notFound).not.toHaveBeenCalled();
    await landing.render(true);
    expect(landing.notFound).toHaveBeenCalledTimes(1);
    expect(landing.opened).not.toHaveBeenCalled();
    await landing.unmount();
});
