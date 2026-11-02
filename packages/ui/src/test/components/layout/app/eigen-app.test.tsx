// EigenApp's hotkey defaults. Two layers can register Escape on the document, such as the find bar and the file
// preview, each gated by `enabled` so only one is on at a time. The hotkey library counts a disabled registration as a
// conflict and warns each time one registers, so the app allows the overlap: no warning, and one close per Escape.
import { expect, mock, test } from 'bun:test';
import { subjectFromMailAttachment } from '@workspace/lib/file-subject';
import { installHappyDom } from '../../../happy-dom';
import { renderInDocument } from '../../../render-in-document';

installHappyDom();

const session = { user: { id: 'owner-1' } };
const realAuth = await import('@workspace/lib/auth');
mock.module('@workspace/lib/auth', () => ({ ...realAuth, useAuth: () => session, useIsGuest: () => false }));

const { act, createElement, Fragment, useState } = await import('react');
const { HotkeysProvider } = await import('@tanstack/react-hotkeys');
const { HOTKEY_DEFAULTS } = await import('../../../../components/layout/app/eigen-app');
const { DocSearchProvider } = await import('../../../../components/search/doc-search-provider');
const { PreviewProvider, usePreview } = await import('../../../../components/preview-provider/preview-provider');
const { Dialog, DialogContent, DialogTitle } = await import('../../../../components/dialog');

const subject = subjectFromMailAttachment('owner-1', 'message-1', 0, {
    contentType: 'application/octet-stream',
    filename: 'ledger.bin',
    size: 2048,
});
const controller = { search: () => [], highlightAll: () => {}, reveal: () => {} };

test('a preview opened over a find-bar surface logs no hotkey conflict, and each Escape closes one layer', async () => {
    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => {
        warnings.push(String(args[0]));
    };
    const card = { closed: 0 };
    const controls = { openAttachment: () => {}, setAboveOpen: (_open: boolean) => {} };
    // A Stickies board: the find bar around it, a card dialog holding an attachment, and a dialog over the preview.
    function Board() {
        const { openPreview } = usePreview();
        const [aboveOpen, setAboveOpen] = useState(false);
        controls.openAttachment = () => openPreview(subject, [subject]);
        controls.setAboveOpen = setAboveOpen;
        return createElement(
            Fragment,
            null,
            createElement(
                Dialog,
                {
                    open: true,
                    onOpenChange: () => {
                        card.closed += 1;
                    },
                },
                createElement(
                    DialogContent,
                    { 'aria-describedby': undefined },
                    createElement(DialogTitle, null, 'Card'),
                ),
            ),
            createElement(
                Dialog,
                { open: aboveOpen, onOpenChange: setAboveOpen },
                createElement(
                    DialogContent,
                    { 'aria-describedby': undefined },
                    createElement(DialogTitle, null, 'Save to Drive'),
                ),
            ),
        );
    }
    const { unmount } = await renderInDocument(
        createElement(HotkeysProvider, {
            defaultOptions: HOTKEY_DEFAULTS,
            children: createElement(DocSearchProvider, {
                controller,
                children: createElement(PreviewProvider, null, createElement(Board)),
            }),
        }),
    );
    const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    const pressEscape = () =>
        act(async () => {
            (document.activeElement ?? document).dispatchEvent(
                new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }),
            );
        });
    const preview = () => document.querySelector('[data-slot="file-preview"]');

    try {
        await act(async () => controls.openAttachment());
        await settle();
        await act(async () => controls.setAboveOpen(true));
        await settle();
        await act(async () => controls.setAboveOpen(false));
        await settle();
        expect(warnings.filter((warning) => warning.includes('is already registered'))).toEqual([]);

        await pressEscape();
        expect(preview()).toBeNull();
        expect(card.closed).toBe(0);
    } finally {
        console.warn = realWarn;
        await unmount();
    }
});
