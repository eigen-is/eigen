// A landing such as `?chat=` opens its comment only once the host is ready, so it never opens a comment in a state the
// host is about to change. A name that finds no comment by then is reported once.
import { expect, mock, test } from 'bun:test';
import { installHappyDom } from '../../../happy-dom';

// react-dom needs a DOM to render the hook into.
installHappyDom();

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { useOpenOnLanding } = await import('../../../../core/comments/hooks/use-open-on-landing');

async function mountLanding(name: string) {
    const open = mock((landing: string) => landing === 'thread-1.eigenchat');
    const notFound = mock(() => {});
    const root = createRoot(document.createElement('div'));
    function Harness({ ready }: { ready: boolean }) {
        useOpenOnLanding(name, open, { ready, onNotFound: notFound });
        return null;
    }
    const render = (ready: boolean) =>
        act(async () => {
            root.render(<Harness ready={ready} />);
        });
    return { open, notFound, render, unmount: () => act(() => root.unmount()) };
}

test('a landing waits for the host to be ready, then opens its comment once', async () => {
    const landing = await mountLanding('thread-1.eigenchat');
    await landing.render(false);
    expect(landing.open).not.toHaveBeenCalled();
    await landing.render(true);
    await landing.render(true);
    expect(landing.open.mock.calls).toEqual([['thread-1.eigenchat']]);
    expect(landing.notFound).not.toHaveBeenCalled();
    await landing.unmount();
});

test('a name that finds no comment is reported once the host is ready', async () => {
    const landing = await mountLanding('gone.eigenchat');
    await landing.render(false);
    expect(landing.notFound).not.toHaveBeenCalled();
    await landing.render(true);
    await landing.render(true);
    expect(landing.notFound).toHaveBeenCalledTimes(1);
    await landing.unmount();
});
