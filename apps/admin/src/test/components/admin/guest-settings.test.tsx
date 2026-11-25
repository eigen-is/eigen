// Guest access keeps the page contract, saves only the guest settings it changed, and shows no Save for a switch
// turned back to what was saved. The days field takes what is typed, an emptied field included, and a number of days
// outside what the server takes says so under the field and saves nothing.
import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import type { ServerSettings } from '@workspace/lib/types/settings';
import type { DeepPartial } from '@workspace/lib/types/util';
import { expectFormContract } from '@workspace/ui/test/form-contract';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { pressEnter } from '@workspace/ui/test/press-enter';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

const GUESTS: ServerSettings['guests'] = { openSignup: false, inactivityDays: 7 };
const saveSettings = mock(async (_patch: DeepPartial<ServerSettings>) => ({}));
afterEach(() => saveSettings.mockClear());

// A copy, because mock.module rewrites a loaded module's exports in place, and afterAll puts the original back.
const realSettings = { ...(await import('@workspace/lib/settings')) };
mock.module('@workspace/lib/settings', () => ({
    ...realSettings,
    useServerSettings: () => ({ data: { guests: GUESTS }, isLoading: false }),
    useUpdateServerSettings: () => ({ mutateAsync: saveSettings, isPending: false }),
}));
afterAll(() => {
    mock.module('@workspace/lib/settings', () => realSettings);
});

const { act, createElement } = await import('react');
const router = await import('@tanstack/react-router');
const { GuestSettingsPage } = await import('../../../components/admin/guest-settings');

async function openPage() {
    const root = router.createRootRoute({ component: router.Outlet });
    const page = router.createRoute({ getParentRoute: () => root, path: '/', component: GuestSettingsPage });
    const memory = router.createRouter({
        routeTree: root.addChildren([page]),
        history: router.createMemoryHistory({ initialEntries: ['/'] }),
    });
    await memory.load();
    await renderInDocument(createElement(router.RouterProvider, { router: memory }));
}

const DAYS = 'Days of inactivity before deletion';
const control = (label: string) => {
    const tag = [...document.querySelectorAll('label')].find((l) => l.textContent === label);
    const element = tag && document.getElementById(tag.htmlFor);
    if (!(element instanceof HTMLElement)) throw new Error(`no control labelled ${label}`);
    return element;
};
// React reads the value off its own tracker, so the native setter is what a keystroke looks like.
const typeDays = (value: string) =>
    act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(control(DAYS), value);
        control(DAYS).dispatchEvent(new Event('input', { bubbles: true }));
    });
const saveButton = () => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Save');

test('Guest access keeps the page contract', async () => {
    await expectFormContract({
        kind: 'page',
        render: () => createElement(GuestSettingsPage),
        submitLabel: 'Save',
        firstField: DAYS,
        onSubmit: saveSettings,
        makeChanged: () => typeDays('30'),
        makeInvalid: () => typeDays('999'),
        invalidField: DAYS,
    });
});

test('Save sends only the guest settings that changed', async () => {
    await openPage();
    await typeDays('30');
    const days = control(DAYS);
    if (!(days instanceof HTMLInputElement)) throw new Error('the days field is no input');
    await act(async () => pressEnter(days));
    expect(saveSettings.mock.calls).toEqual([[{ guests: { inactivityDays: 30 } }]]);
});

test('a switch turned back to what was saved leaves nothing to save', async () => {
    await openPage();
    const toggle = () => act(async () => control('Allow open guest signup').click());
    await toggle();
    expect(saveButton()).toBeDefined();
    await toggle();
    expect(saveButton()).toBeUndefined();
});

test('the days field can be emptied and retyped, and days outside 1 to 365 are refused under it', async () => {
    await openPage();
    const days = control(DAYS);
    if (!(days instanceof HTMLInputElement)) throw new Error('the days field is no input');
    await typeDays('');
    expect(days.value).toBe('');
    await typeDays('0');
    expect(days.value).toBe('0');
    await act(async () => pressEnter(days));
    expect(saveSettings).not.toHaveBeenCalled();
    const message = document.getElementById(days.getAttribute('aria-describedby') ?? '');
    expect(message?.textContent).toBe('A whole number of days, from 1 to 365');

    await typeDays('365');
    await act(async () => pressEnter(days));
    expect(saveSettings.mock.calls).toEqual([[{ guests: { inactivityDays: 365 } }]]);
});
