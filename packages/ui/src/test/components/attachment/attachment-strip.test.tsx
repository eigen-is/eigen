import { expect, test } from 'bun:test';
import { installHappyDom } from '../../happy-dom';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

const { act } = await import('react');
const { AttachmentStrip } = await import('../../../components/attachment/attachment-strip');

// happy-dom lays nothing out and loads no CSS, so the scroller gets a 300px window on five chips 208px apart, each
// snapping at its start.
async function renderStrip(onChipClick: () => void = () => {}) {
    const { container } = await renderInDocument(
        <AttachmentStrip>
            {['a', 'b', 'c', 'd', 'e'].map((name) => (
                <a key={name} href={`/${name}`} onClick={onChipClick}>
                    {name}.png
                </a>
            ))}
        </AttachmentStrip>,
    );
    const scroller = container.querySelector<HTMLElement>('[class*="overflow-x-auto"]');
    if (!scroller) throw new Error('No scroller rendered');
    for (const [i, chip] of scroller.querySelectorAll('a').entries()) {
        Object.defineProperty(chip, 'offsetLeft', { value: i * 208 });
        chip.style.scrollSnapAlign = 'start';
    }
    Object.defineProperty(scroller, 'clientWidth', { value: 300 });
    Object.defineProperty(scroller, 'scrollWidth', { value: 1000 });
    const scrollTo = (left: number) =>
        act(async () => {
            scroller.scrollLeft = left;
            scroller.dispatchEvent(new Event('scroll'));
        });
    const button = (label: string) => container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
    return { scroller, scrollTo, button };
}

test('a button shows on each side that hides chips', async () => {
    const { scrollTo, button } = await renderStrip();
    await scrollTo(0);
    expect(button('Previous attachments')).toBeNull();
    expect(button('Next attachments')).not.toBeNull();
    await scrollTo(300);
    expect(button('Previous attachments')).not.toBeNull();
    expect(button('Next attachments')).not.toBeNull();
    await scrollTo(700);
    expect(button('Previous attachments')).not.toBeNull();
    expect(button('Next attachments')).toBeNull();
});

test('next steps most of the visible width', async () => {
    const { scroller, scrollTo, button } = await renderStrip();
    await scrollTo(0);
    let stepped = 0;
    scroller.scrollBy = (options?: ScrollToOptions | number) => {
        if (typeof options === 'object') stepped = options.left ?? 0;
    };
    await act(async () => button('Next attachments')?.click());
    expect(stepped).toBe(240);
});

test('a mouse drag pans the row, glides on to the next chip, and its click opens no chip', async () => {
    // Reduced motion lands the glide in one frame.
    const realMatchMedia = window.matchMedia;
    Object.assign(window, { matchMedia: () => ({ matches: true }) });
    let opened = 0;
    const { scroller, scrollTo } = await renderStrip(() => opened++);
    await scrollTo(0);
    const chip = scroller.querySelector('a');
    const pointer = (type: string, clientX: number) =>
        act(async () => {
            chip?.dispatchEvent(new PointerEvent(type, { pointerType: 'mouse', button: 0, clientX, bubbles: true }));
        });
    await pointer('pointerdown', 500);
    await pointer('pointermove', 400);
    expect(scroller.hasAttribute('data-dragging')).toBe(true);
    expect(scroller.scrollLeft).toBe(100);
    await pointer('pointerup', 400);
    await act(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    expect(scroller.scrollLeft).toBe(208);
    expect(scroller.hasAttribute('data-dragging')).toBe(false);
    await act(async () => chip?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
    expect(opened).toBe(0);
    window.matchMedia = realMatchMedia;
});
