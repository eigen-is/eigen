import { expect, test } from 'bun:test';
import { installHappyDom } from '../../happy-dom';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

const { act } = await import('react');
const { AttachmentStrip } = await import('../../../components/attachment/attachment-strip');

// happy-dom lays nothing out, so the scroller gets a 300px window on 1000px of chips, scrolled to `left`.
async function renderStrip(onChipClick: () => void = () => {}) {
    const { container } = await renderInDocument(
        <AttachmentStrip>
            <a href="/a" onClick={onChipClick}>
                a.png
            </a>
        </AttachmentStrip>,
    );
    const scroller = container.querySelector<HTMLElement>('[class*="overflow-x-auto"]');
    if (!scroller) throw new Error('No scroller rendered');
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

test('a mouse drag pans the row, and its click opens no chip', async () => {
    let opened = 0;
    const { scroller, scrollTo } = await renderStrip(() => opened++);
    await scrollTo(200);
    const chip = scroller.querySelector('a');
    const pointer = (type: string, clientX: number) =>
        act(async () => {
            chip?.dispatchEvent(new PointerEvent(type, { pointerType: 'mouse', button: 0, clientX, bubbles: true }));
        });
    await pointer('pointerdown', 500);
    await pointer('pointermove', 400);
    expect(scroller.hasAttribute('data-dragging')).toBe(true);
    expect(scroller.scrollLeft).toBe(300);
    await pointer('pointerup', 400);
    expect(scroller.hasAttribute('data-dragging')).toBe(false);
    await act(async () => chip?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
    expect(opened).toBe(0);
});
