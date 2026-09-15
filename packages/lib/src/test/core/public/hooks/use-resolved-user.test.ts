// What `avatarSrc` is for the three shapes an avatar value takes: a relative cache path the API serves,
// an absolute URL, and the inline `data:` photo a vCard preview builds from a card's PHOTO.
import { afterAll, describe, expect, mock, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import { API_HOST } from '@workspace/lib/api';
import { installHappyDom } from '../../../happy-dom';

// react-dom needs a DOM to render the hook into.
installHappyDom();

// Signed out: the contact and public-user queries stay disabled, so the hook resolves off `imageUrl` alone.
const realAuthContextModule = await import('../../../../core/auth/auth-context');
mock.module('../../../../core/auth/auth-context', () => ({
    useAuth: () => ({ user: null }),
}));

afterAll(() => {
    mock.module('../../../../core/auth/auth-context', () => realAuthContextModule);
});

async function avatarSrcFor(imageUrl: string): Promise<string> {
    const { act, createElement } = await import('react');
    const { createRoot } = await import('react-dom/client');
    const { QueryClientProvider } = await import('@tanstack/react-query');
    const { useResolvedUser } = await import('../../../../core/public/hooks/use-resolved-user');

    const seen = { src: '' };
    function Harness() {
        seen.src = useResolvedUser({ email: 'ada@example.com', imageUrl }).avatarSrc;
        return null;
    }
    const container = document.createElement('div');
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
        root.render(createElement(QueryClientProvider, { client: queryClient }, createElement(Harness, null)));
    });
    await act(() => root.unmount());
    return seen.src;
}

describe('useResolvedUser — avatarSrc', () => {
    test('a relative cache path is served by the API, as before', async () => {
        expect(await avatarSrcFor('contacts/avatars/abc.webp')).toBe(`${API_HOST}/contacts/avatars/abc.webp`);
    });

    test('an absolute URL is left alone', async () => {
        expect(await avatarSrcFor('https://cdn.example.com/ada.png')).toBe('https://cdn.example.com/ada.png');
    });

    test('an inline data: photo is the image itself, never a path under the API host', async () => {
        const dataUri = 'data:image/jpeg;base64,AAAA';
        expect(await avatarSrcFor(dataUri)).toBe(dataUri);
    });
});
