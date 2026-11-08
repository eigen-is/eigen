// A Radix dialog dismisses on Escape from a document capture listener, which runs before the textarea
// hears the key. Pinned here: Escape with the @-mention list open closes only the list, inside a dialog
// as well, and Escape with nothing open still closes the dialog. Also pinned: a send clears the box at
// once, and a failed one puts its text and files back unless the user has started the next message, and one no toast
// told the user about still surfaces. A send that takes no files, a slash command that runs here, puts its files back too.
import { expect, mock, test } from 'bun:test';
import { installHappyDom } from '../../happy-dom';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

const realAuth = await import('@workspace/lib/auth');
mock.module('@workspace/lib/auth', () => ({ ...realAuth, useAuth: () => ({ user: null }), useIsGuest: () => false }));

const { act, createElement, createRef } = await import('react');
const { onMutationError } = await import('@workspace/lib/api-error');
const { Dialog, DialogContent, DialogDescription, DialogTitle } = await import('../../../components/dialog');
const { ChatMessageInput } = await import('../../../components/chat/chat-message-input');
type ChatMessageInputHandle = import('../../../components/chat/chat-message-input').ChatMessageInputHandle;

const roomMembers = [{ email: 'ada@example.com', displayName: 'Ada' }];
const inputProps = {
    disabled: false,
    readOnly: false,
    placeholder: 'Reply...',
    roomMembers,
    currentUserEmail: 'me@example.com',
    messageCount: 0,
    onAttachClick: () => {},
    driveAttachments: [],
    onRemoveDriveAttachment: () => {},
};

async function mount() {
    const closed = { count: 0 };
    const { unmount } = await renderInDocument(
        createElement(
            Dialog,
            {
                open: true,
                onOpenChange: (open: boolean) => {
                    if (!open) closed.count += 1;
                },
            },
            createElement(
                DialogContent,
                null,
                createElement(DialogTitle, null, 'Card'),
                createElement(DialogDescription, null, 'Replies'),
                createElement(ChatMessageInput, { ...inputProps, onSend: async () => true }),
            ),
        ),
    );
    const textarea = document.querySelector('textarea');
    if (!textarea) throw new Error('the input drew no textarea');

    const type = async (value: string) => {
        await act(async () => {
            Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea, value);
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
        });
    };
    const pressEscape = async () => {
        await act(async () => {
            textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        });
    };
    return { closed, textarea, type, pressEscape, cleanup: unmount };
}

test('Escape with the @-mention list open closes the list, not the dialog', async () => {
    const { closed, textarea, type, pressEscape, cleanup } = await mount();
    await type('hi @');
    expect(document.querySelectorAll('li')).toHaveLength(1);

    await pressEscape();
    expect(closed.count).toBe(0);
    expect(textarea.value).toBe('hi ');
    expect(document.querySelectorAll('li')).toHaveLength(0);

    await pressEscape();
    expect(closed.count).toBe(1);
    await cleanup();
});

test('Escape on an @-mention with no matches closes the dialog', async () => {
    const { closed, type, pressEscape, cleanup } = await mount();
    await type('hi @zed');
    await pressEscape();
    expect(closed.count).toBe(1);
    await cleanup();
});

// A send's promise stays open until the test settles it, as on a slow network.
// The composer drops the end of its send's promise chain, and `.then` builds each link with this class, so the last one
// built is what the composer leaves to the runtime.
class WatchedSend<T> extends Promise<T> {
    public static lastLink: Promise<unknown> | null = null;
    public constructor(executor: ConstructorParameters<typeof Promise<T>>[0]) {
        super(executor);
        WatchedSend.lastLink = this;
    }
}

async function mountSending() {
    const sends: {
        content: string;
        files?: File[];
        resolve: (filesTaken: boolean) => void;
        reject: () => void;
        break: (error: Error) => void;
    }[] = [];
    const onSend = (content: string, files?: File[]) =>
        new WatchedSend<boolean>((resolve, reject) => {
            const rejectToasted = () => {
                const error = new Error('server down');
                onMutationError(error);
                reject(error);
            };
            sends.push({ content, files, resolve, reject: rejectToasted, break: reject });
        });
    const input = createRef<ChatMessageInputHandle>();
    const { unmount } = await renderInDocument(createElement(ChatMessageInput, { ...inputProps, onSend, ref: input }));
    const textarea = document.querySelector('textarea');
    if (!textarea) throw new Error('the input drew no textarea');

    const type = async (value: string) => {
        await act(async () => {
            Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea, value);
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
        });
    };
    const pressEnter = async () => {
        await act(async () => {
            textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        });
    };
    const stage = async (file: File) => {
        await act(async () => input.current?.addFiles([file]));
    };
    return { sends, textarea, type, pressEnter, stage, cleanup: unmount };
}

const photo = new File(['pixels'], 'photo.png', { type: 'image/png' });
const stagedText = () => document.body.textContent ?? '';

test('a send clears the box at once, so a second Enter on a slow network sends nothing', async () => {
    const { sends, textarea, type, pressEnter, stage, cleanup } = await mountSending();
    await type('hello');
    await stage(photo);
    await pressEnter();
    expect(textarea.value).toBe('');
    expect(stagedText()).not.toContain('photo.png');

    await pressEnter();
    expect(sends).toHaveLength(1);
    await cleanup();
});

test('a local command clears its text and keeps the staged files', async () => {
    const { sends, textarea, type, pressEnter, stage, cleanup } = await mountSending();
    await type('/help');
    await stage(photo);
    await pressEnter();
    await act(async () => sends[0].resolve(false));
    expect(textarea.value).toBe('');
    expect(stagedText()).toContain('photo.png');
    await cleanup();
});

test('a failed send puts the text and files back, and they send again', async () => {
    const { sends, textarea, type, pressEnter, stage, cleanup } = await mountSending();
    await type('hello');
    await stage(photo);
    await pressEnter();
    await act(async () => sends[0].reject());
    expect(textarea.value).toBe('hello');
    expect(stagedText()).toContain('photo.png');

    await pressEnter();
    expect(sends[1].content).toBe('hello');
    expect(sends[1].files).toEqual([photo]);
    await cleanup();
});

test('a failed send no toast told the user about puts the text back and surfaces', async () => {
    const { sends, textarea, type, pressEnter, cleanup } = await mountSending();
    await type('hello');
    await pressEnter();
    const bug = new Error('a bug in the send handler');
    const surfaced = WatchedSend.lastLink?.catch((error: unknown) => error);
    await act(async () => sends[0].break(bug));
    expect(await surfaced).toBe(bug);
    expect(textarea.value).toBe('hello');
    await cleanup();
});

test('a failed send leaves the next message alone when the user has started typing it', async () => {
    const { sends, textarea, type, pressEnter, stage, cleanup } = await mountSending();
    await type('first');
    await stage(photo);
    await pressEnter();
    await type('second');
    const otherPhoto = new File(['pixels'], 'other.png', { type: 'image/png' });
    await stage(otherPhoto);
    await act(async () => sends[0].reject());
    expect(textarea.value).toBe('second');
    expect(stagedText()).toContain('other.png');
    expect(stagedText()).not.toContain('photo.png');
    await cleanup();
});

test('a send that succeeds leaves the box empty', async () => {
    const { sends, textarea, type, pressEnter, cleanup } = await mountSending();
    await type('hello');
    await pressEnter();
    await act(async () => sends[0].resolve(true));
    expect(textarea.value).toBe('');
    await cleanup();
});

test('text put back after a failed send grows the box to fit, as typing does', async () => {
    const { sends, textarea, type, pressEnter, cleanup } = await mountSending();
    Object.defineProperty(textarea, 'scrollHeight', { get: () => (textarea.value.includes('\n') ? 80 : 40) });
    await type('one\ntwo\nthree');
    expect(textarea.style.height).toBe('80px');
    await pressEnter();
    expect(textarea.style.height).toBe('40px');

    await act(async () => sends[0].reject());
    expect(textarea.style.height).toBe('80px');
    await cleanup();
});
