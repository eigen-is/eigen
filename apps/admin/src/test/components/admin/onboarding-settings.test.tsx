// Onboarding keeps the page contract, and Cmd or Ctrl+Enter in an email body saves the page with no line break added,
// since the body is a rich-text field inside the form. Each body is named by its Body label.
import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import type { ServerSettings } from '@workspace/lib/types/settings';
import type { DeepPartial } from '@workspace/lib/types/util';
import { expectFormContract, type } from '@workspace/ui/test/form-contract';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

const ONBOARDING: ServerSettings['onboarding'] = {
    waitlist: { enabled: true },
    autoAddOwnerContact: false,
    welcomeMail: { enabled: false, subject: '', body: '' },
    inviteEmail: { subject: 'You are in', body: '<p>Welcome</p>' },
};
const saveSettings = mock(async (_patch: DeepPartial<ServerSettings>) => ({}));
afterEach(() => saveSettings.mockClear());

// Copies, because mock.module rewrites a loaded module's exports in place, and afterAll puts the originals back.
const realSettings = { ...(await import('@workspace/lib/settings')) };
mock.module('@workspace/lib/settings', () => ({
    ...realSettings,
    useServerSettings: () => ({ data: { onboarding: ONBOARDING }, isLoading: false }),
    useUpdateServerSettings: () => ({ mutateAsync: saveSettings, isPending: false }),
}));
const realPublic = { ...(await import('@workspace/lib/public')) };
mock.module('@workspace/lib/public', () => ({ ...realPublic, useMailEnabled: () => true }));
afterAll(() => {
    mock.module('@workspace/lib/settings', () => realSettings);
    mock.module('@workspace/lib/public', () => realPublic);
});

const { act, createElement } = await import('react');
const router = await import('@tanstack/react-router');
const { OnboardingSettingsPage } = await import('../../../components/admin/onboarding-settings');

async function openPage() {
    const root = router.createRootRoute({ component: router.Outlet });
    const page = router.createRoute({ getParentRoute: () => root, path: '/', component: OnboardingSettingsPage });
    const memory = router.createRouter({
        routeTree: root.addChildren([page]),
        history: router.createMemoryHistory({ initialEntries: ['/'] }),
    });
    await memory.load();
    await renderInDocument(createElement(router.RouterProvider, { router: memory }));
}

test('Onboarding keeps the page contract', async () => {
    await expectFormContract({
        kind: 'page',
        render: () => createElement(OnboardingSettingsPage),
        submitLabel: 'Save',
        firstField: 'Subject',
        onSubmit: saveSettings,
        makeChanged: () => type('Subject', 'Hi'),
        modEnterFields: ['Body'],
    });
});

test('Ctrl+Enter in an email body saves the page, with no line break added', async () => {
    await openPage();
    await type('Subject', 'You are in!');
    const body = document.querySelector('.ProseMirror');
    if (!body) throw new Error('the page has no invite body');
    // Happy-dom is no Mac, so the editor's Mod is Ctrl.
    await act(async () => {
        body.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }),
        );
    });
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    // A line break would have changed the body, and the draft would carry it.
    expect(saveSettings.mock.calls).toEqual([[{ onboarding: { inviteEmail: { subject: 'You are in!' } } }]]);
});
