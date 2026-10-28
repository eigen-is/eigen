// The Preferences page sits in Space's nav right below Personal info. It picks the theme and turns
// celebrations on or off, each change saved through the personal settings at once. Personal info holds
// the profile alone.
import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import type { UserSettings } from '@workspace/lib/types/settings';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

// A desktop window, where the nav shows its labels beside the icons.
installHappyDom().happyDOM.setViewport({ width: 1440, height: 900 });

// The settings query and the save, stubbed: one object each, so effects that depend on them settle.
const session = { user: { id: 'u1', email: 'me@test.eigen.is', name: 'Me' } };
const settings: { data: UserSettings | undefined; isLoading: boolean } = { data: {}, isLoading: false };
const update = { mutate: mock((_body: UserSettings) => {}) };
// Copies, because mock.module rewrites a loaded module's exports in place, and afterAll puts the originals back.
const realAuth = { ...(await import('@workspace/lib/auth')) };
const realSpace = { ...(await import('@workspace/lib/space')) };
mock.module('@workspace/lib/auth', () => ({ ...realAuth, useAuth: () => session }));
mock.module('@workspace/lib/space', () => ({
    ...realSpace,
    useSpaceSettings: () => settings,
    useUpdateSpaceSettings: () => update,
}));
afterAll(() => {
    mock.module('@workspace/lib/auth', () => realAuth);
    mock.module('@workspace/lib/space', () => realSpace);
});

const { act, createElement } = await import('react');
const { createMemoryHistory, createRouter, RouterProvider } = await import('@tanstack/react-router');
const { UploadProvider } = await import('@workspace/ui/components/upload-provider');
const { routeTree } = await import('../../routeTree.gen');

const auth = {
    isAuthenticated: true,
    isLoading: false,
    user: { ...session.user, emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
    login: async () => ({ success: true }),
    logout: async () => {},
};

let unmount = async () => {};
afterEach(() => unmount());
beforeEach(() => {
    settings.data = {};
    update.mutate.mockClear();
});

async function open(url: string) {
    const router = createRouter({
        routeTree,
        history: createMemoryHistory({ initialEntries: [url] }),
        context: { auth },
    });
    await router.load();
    // The profile's picture uploads through the provider every app mounts around its routes.
    const rendered = await renderInDocument(
        createElement(UploadProvider, null, createElement(RouterProvider, { router })),
    );
    unmount = rendered.unmount;
    return () => rendered.container.textContent ?? '';
}

function control(label: string): HTMLElement | null {
    const element = [...document.querySelectorAll('label')].find((l) => l.textContent === label);
    return element ? document.getElementById(element.htmlFor) : null;
}

const click = (element: Element | null | undefined) =>
    act(async () => {
        if (!element) throw new Error('nothing to click');
        element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
        element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
        element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

// The page's links, the nav's among them, in order, as label and target.
const nav = () => [...document.querySelectorAll('a')].map((a) => [a.textContent, a.getAttribute('href')]);

test('the nav lists Preferences right below Personal info', async () => {
    await open('/preferences');
    const links = nav();
    const personalInfo = links.findIndex(([label]) => label === 'Personal info');
    expect(personalInfo).toBeGreaterThanOrEqual(0);
    expect(links[personalInfo + 1]).toEqual(['Preferences', '/preferences']);
});

test('the theme shows Light until the user picks one, and the saved one after', async () => {
    await open('/preferences');
    expect(control('Theme')?.textContent).toBe('Light');
    await unmount();

    settings.data = { theme: 'system' };
    await open('/preferences');
    expect(control('Theme')?.textContent).toBe('System');
});

test('picking Dark saves the dark theme', async () => {
    await open('/preferences');
    await click(control('Theme'));
    const options = [...document.querySelectorAll('[role="option"]')];
    expect(options.map((o) => o.textContent)).toEqual(['Light', 'Dark', 'System']);
    await click(options.find((o) => o.textContent === 'Dark'));
    expect(update.mutate).toHaveBeenCalledWith({ theme: 'dark' });
});

test('the Celebrations switch shows the setting, on when unset, and a flip saves it', async () => {
    await open('/preferences');
    expect(control('Celebrations')?.getAttribute('aria-checked')).toBe('true');
    await click(control('Celebrations'));
    expect(update.mutate).toHaveBeenCalledWith({ celebrations: false });
    await unmount();

    settings.data = { celebrations: false };
    await open('/preferences');
    expect(control('Celebrations')?.getAttribute('aria-checked')).toBe('false');
});

test('Personal info holds the profile without Celebrations', async () => {
    const text = await open('/user');
    expect(text()).toContain('Edit profile');
    expect(text()).not.toContain('Celebrations');
});
