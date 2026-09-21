// The overlay's keys listen on the document, and everything its content can open above it — a picker,
// the `.eml` reader header's details popover — is a layer of its own that handles Escape itself. What is
// pinned here is that the overlay stands its keys down while such a layer is open, and that Space on a
// focused control inside the overlay is that control's own activation rather than a close.
import { expect, mock, test } from 'bun:test';
import { subjectFromMailAttachment } from '@workspace/lib/file-subject';
import { installHappyDom } from '../../happy-dom';

installHappyDom();

const session = { user: { id: 'owner-1' } };
mock.module('@workspace/lib/auth', () => ({ useAuth: () => session, useIsGuest: () => false }));

const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { Popover, PopoverContent, PopoverTrigger } = await import('../../../components/popover');
const { PreviewContext } = await import('../../../components/preview-provider/preview-context');
const { FilePreview } = await import('../../../components/drive/file-preview');

// A part with no preview of its own: the overlay draws its file card, and no query runs.
const subject = subjectFromMailAttachment('owner-1', 'message-1', 0, {
    contentType: 'application/octet-stream',
    filename: 'ledger.bin',
    size: 2048,
});

const preview = { openPreview: () => {}, updatePreview: () => {}, closePreview: () => {}, isPreviewOpen: true };

async function mount(popoverOpen: boolean) {
    const closed = { count: 0 };
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
        root.render(
            createElement(
                QueryClientProvider,
                { client: new QueryClient() },
                createElement(
                    PreviewContext.Provider,
                    { value: preview },
                    createElement(FilePreview, {
                        subject,
                        siblings: [subject],
                        onClose: () => {
                            closed.count += 1;
                        },
                        onPrev: () => {},
                        onNext: () => {},
                    }),
                    // The shape of the header's details popover: Radix portals it to the body, above the overlay.
                    createElement(
                        Popover,
                        { open: popoverOpen },
                        createElement(PopoverTrigger, null, 'to: Ada'),
                        createElement(PopoverContent, null, 'from: ada@example.com'),
                    ),
                ),
            ),
        );
    });

    const press = async (key: string, from: EventTarget = document) => {
        const event = new KeyboardEvent('keydown', {
            key,
            code: key === ' ' ? 'Space' : key,
            bubbles: true,
            cancelable: true,
        });
        await act(async () => {
            from.dispatchEvent(event);
        });
        return event;
    };
    const cleanup = async () => {
        await act(async () => root.unmount());
        container.remove();
    };
    return { closed, press, cleanup };
}

test('Escape closes the overlay when nothing is open above it', async () => {
    const { closed, press, cleanup } = await mount(false);
    await press('Escape');
    expect(closed.count).toBe(1);
    await cleanup();
});

test('Escape with a layer open above the overlay is that layer’s, not the overlay’s', async () => {
    const { closed, press, cleanup } = await mount(true);
    await press('Escape');
    expect(closed.count).toBe(0);
    await cleanup();
});

test('Space on a focused control inside the overlay is that control’s own activation', async () => {
    const { closed, press, cleanup } = await mount(false);
    const button = document.querySelector('[data-preview-overlay] button');
    if (!button) throw new Error('the overlay drew no button');
    const onButton = await press(' ', button);
    expect(closed.count).toBe(0);
    // The overlay's own hotkey must prevent no default here, or the button never presses.
    expect(onButton.defaultPrevented).toBe(false);

    const onOverlay = await press(' ');
    expect(closed.count).toBe(1);
    expect(onOverlay.defaultPrevented).toBe(true);
    await cleanup();
});

// A menu and a listbox are layers above the overlay the same way a dialog is, and their own Escape
// runs on the capture phase of the very keydown the overlay hears later: presence is settled by then,
// so where the key was pressed is what says whose Escape it was.
test.each(['menu', 'listbox'])('Escape inside an open %s above the overlay is not the overlay’s', async (role) => {
    const { closed, press, cleanup } = await mount(false);
    const layer = document.createElement('div');
    layer.setAttribute('role', role);
    const item = document.createElement('button');
    layer.append(item);
    document.body.append(layer);

    await press('Escape', item);
    expect(closed.count).toBe(0);

    // The same key, pressed anywhere else, is still the overlay's.
    layer.remove();
    await press('Escape');
    expect(closed.count).toBe(1);
    await cleanup();
});
