// Email collaborators: a subject seeded with the file's name, a message seeded with the user's signature, and a copy to
// self. Send waits until the message says more than the signature, and while the subject or the message is too long.
// Enter in the subject sends, Enter in the message starts a new paragraph. A send closes the dialog, and a failed one
// stays open with what was typed.
import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import type { Editor } from '@tiptap/react';
import { DRIVE_MIME_DOC } from '@workspace/lib/types/drive';
import { drivePath } from '../../drive-path';
import { installHappyDom } from '../../happy-dom';
import { pressEnter } from '../../press-enter';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

type EmailVariables = { pathId: string; subject: string; message: string; sendCopyToSelf: boolean };
const sendEmail = mock(async (_variables: EmailVariables) => {});
// Copies, because mock.module rewrites a loaded module's exports in place, and afterAll puts the originals back.
const realDrive = { ...(await import('@workspace/lib/drive')) };
const realSpace = { ...(await import('@workspace/lib/space')) };
mock.module('@workspace/lib/drive', () => ({
    ...realDrive,
    useEmailCollaborators: () => ({
        mutateAsync: sendEmail,
        mutate: (variables: EmailVariables, options?: { onSuccess?: () => void }) =>
            sendEmail(variables).then(options?.onSuccess, () => {}),
        isPending: false,
    }),
}));
mock.module('@workspace/lib/space', () => ({
    ...realSpace,
    useSpaceSettings: () => ({ data: { email: { signatures: [{ html: '<p>Reinder</p>' }] } } }),
}));
afterAll(() => {
    mock.module('@workspace/lib/drive', () => realDrive);
    mock.module('@workspace/lib/space', () => realSpace);
});

const { act, createElement, useState } = await import('react');
const { onMutationError } = await import('@workspace/lib/api-error');
const { DriveEmailCollaborators } = await import('../../../components/drive/drive-email-collaborators');

const toasted = (message: string) => {
    const failure = new Error(message);
    onMutationError(failure);
    return failure;
};

const onOpenChange = mock((_open: boolean) => {});
let unmount = async () => {};
afterEach(() => unmount());
beforeEach(() => {
    sendEmail.mockReset();
    sendEmail.mockImplementation(async () => {});
    onOpenChange.mockClear();
});

function Harness() {
    const [open, setOpen] = useState(true);
    return createElement(DriveEmailCollaborators, {
        path: drivePath({ id: 'notes', name: 'Notes.eigendoc', mimeType: DRIVE_MIME_DOC }),
        open,
        onOpenChange: (next: boolean) => {
            onOpenChange(next);
            setOpen(next);
        },
    });
}

async function open() {
    ({ unmount } = await renderInDocument(createElement(Harness)));
    await settle();
}

const dialog = () => document.querySelector('[role="dialog"]');
const button = (label: string) =>
    [...(dialog()?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find((b) => b.textContent === label);
const subjectField = () => {
    const input = document.querySelector<HTMLInputElement>('[role="dialog"] input#email-subject');
    if (!input) throw new Error('the dialog has no subject field');
    return input;
};
// Tiptap hangs its editor on the editable element.
const messageEditor = (): Editor => {
    const editable: (HTMLElement & { editor?: Editor }) | null = document.querySelector('[role="dialog"] .ProseMirror');
    if (!editable?.editor) throw new Error('the dialog has no message editor');
    return editable.editor;
};
const typeSubject = (value: string) =>
    act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(subjectField(), value);
        subjectField().dispatchEvent(new Event('input', { bubbles: true }));
    });
const typeMessage = (text: string) =>
    act(async () => {
        messageEditor().chain().focus('start').insertContent(text).run();
    });
const counter = () =>
    [...(dialog()?.querySelectorAll('div') ?? [])]
        .map((d) => d.textContent)
        .find((text) => /^[\d,]+\/10,000$/.test(text ?? ''));
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

test('the dialog shows a subject, a message seeded with the signature, a copy to self, Cancel and Send', async () => {
    await open();
    expect(dialog()?.querySelector('h2')?.textContent).toBe('Email collaborators');
    expect(document.querySelector('label[for="email-subject"]')?.textContent).toBe('Subject');
    expect(subjectField().value).toBe('Notes');
    expect(dialog()?.textContent).toContain('Message');
    expect(messageEditor().getText()).toBe('Reinder');
    expect(document.querySelector('label[for="email-copy-self"]')?.textContent).toBe('Send copy to self');
    expect(document.querySelector('#email-copy-self')?.getAttribute('aria-checked')).toBe('true');
    expect(button('Cancel')).toBeDefined();
    expect(button('Send')?.disabled).toBe(true);
});

test('Send hands the subject, the message and the copy on, and closes once it is sent', async () => {
    await open();
    await typeSubject('Notes for Monday');
    await typeMessage('Please read this. ');
    expect(button('Send')?.disabled).toBe(false);
    await act(async () => button('Send')?.click());
    await settle();
    expect(sendEmail.mock.calls).toEqual([
        [
            {
                pathId: 'notes',
                subject: 'Notes for Monday',
                message: '<p>Please read this. Reinder</p>',
                sendCopyToSelf: true,
            },
        ],
    ]);
    expect(onOpenChange.mock.calls).toEqual([[false]]);
});

test('an emptied subject sends as the file name', async () => {
    await open();
    await typeSubject('  ');
    await typeMessage('Hi. ');
    await act(async () => button('Send')?.click());
    await settle();
    expect(sendEmail.mock.calls[0]?.[0].subject).toBe('Notes');
});

test('Enter in the subject sends', async () => {
    await open();
    await typeMessage('Hi. ');
    await act(async () => pressEnter(subjectField()));
    await settle();
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(onOpenChange.mock.calls).toEqual([[false]]);
});

test('Enter in the message starts a new paragraph and sends nothing', async () => {
    await open();
    await typeMessage('Hi.');
    await act(async () => {
        messageEditor().view.dom.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
        );
    });
    await settle();
    expect(messageEditor().getHTML()).toBe('<p>Hi.</p><p>Reinder</p>');
    expect(sendEmail).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
});

test('Send waits for more than the signature, and while the subject or the message is too long', async () => {
    await open();
    expect(button('Send')?.disabled).toBe(true);
    await act(async () => pressEnter(subjectField()));
    await settle();
    expect(sendEmail).not.toHaveBeenCalled();

    await typeMessage('Hi. ');
    expect(button('Send')?.disabled).toBe(false);
    await typeSubject('x'.repeat(201));
    expect(button('Send')?.disabled).toBe(true);
    await typeSubject('x'.repeat(200));
    expect(button('Send')?.disabled).toBe(false);

    await typeMessage('y'.repeat(10000));
    expect(counter()).toBe('10,011/10,000');
    expect(button('Send')?.disabled).toBe(true);
});

test('a send that fails stays open with what was typed', async () => {
    sendEmail.mockImplementation(async () => {
        throw toasted('offline');
    });
    await open();
    await typeSubject('Notes for Monday');
    await typeMessage('Hi. ');
    await act(async () => button('Send')?.click());
    await settle();
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(subjectField().value).toBe('Notes for Monday');
    expect(messageEditor().getText()).toBe('Hi. Reinder');
    expect(button('Send')?.disabled).toBe(false);
});

test('a slow send keeps the Send label and waits with both buttons', async () => {
    let finish = () => {};
    sendEmail.mockImplementation(() => new Promise<void>((resolve) => (finish = resolve)));
    await open();
    await typeMessage('Hi. ');
    await act(async () => button('Send')?.click());
    expect(button('Send')?.disabled).toBe(true);
    expect(button('Cancel')?.disabled).toBe(true);
    await act(async () => finish());
    await settle();
    expect(onOpenChange.mock.calls).toEqual([[false]]);
});
