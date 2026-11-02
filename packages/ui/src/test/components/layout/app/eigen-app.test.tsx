// EigenApp's hotkey defaults. Two keymaps may register the same key on the document, such as the canvas's nudges and
// the file preview's paging, each gated by `enabled` so only one acts. The hotkey library counts a second registration
// as a conflict, a disabled one included, and warns each time one registers, so the app allows the overlap.
import { expect, mock, test } from 'bun:test';
import type { ReactNode } from 'react';
import { installHappyDom } from '../../../happy-dom';
import { renderInDocument } from '../../../render-in-document';

installHappyDom();

// The server is out of reach here: the session and the event stream are the two things EigenApp would ask it for.
const session = { user: { id: 'owner-1' } };
const realAuth = await import('@workspace/lib/auth');
mock.module('@workspace/lib/auth', () => ({
    ...realAuth,
    AuthProvider: ({ children }: { children: ReactNode }) => children,
    useAuth: () => session,
    useIsGuest: () => false,
}));
const realSse = await import('@workspace/lib/sse');
mock.module('@workspace/lib/sse', () => ({ ...realSse, useSSE: () => {} }));

const { createElement } = await import('react');
const { useHotkey } = await import('@tanstack/react-hotkeys');
const { EigenApp } = await import('../../../../components/layout/app/eigen-app');

// EigenApp binds Mod+P to print, and an app may bind the same key again, gated by its own `enabled`.
function SecondPrintKey() {
    useHotkey('Mod+P', () => {}, { enabled: false });
    return null;
}

test('a key two keymaps register under EigenApp logs no conflict warning', async () => {
    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => {
        warnings.push(String(args[0]));
    };
    try {
        const { unmount } = await renderInDocument(createElement(EigenApp, null, createElement(SecondPrintKey)));
        expect(warnings.filter((warning) => warning.includes('is already registered'))).toEqual([]);
        await unmount();
    } finally {
        console.warn = realWarn;
    }
});
