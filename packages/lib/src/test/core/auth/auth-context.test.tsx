// Until the browser's session check has answered, useAuth says the session is loading, also in the server render the
// prerender uses, so what waits for the answer matches the prerendered page. A loadingFallback never blocks that render.

import { afterAll, expect, mock, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';

const realClient = await import('../../../core/auth/hooks/use-auth-client');
mock.module('../../../core/auth/hooks/use-auth-client', () => ({
    ...realClient,
    authClient: { getSession: () => new Promise(() => {}) },
}));
afterAll(() => {
    mock.module('../../../core/auth/hooks/use-auth-client', () => realClient);
});

const { AuthProvider, useAuth } = await import('../../../core/auth/auth-context');

function Status() {
    return <p>{useAuth().isLoading ? 'loading' : 'answered'}</p>;
}

function serverRender(fallback?: string): string {
    return renderToStaticMarkup(
        <QueryClientProvider client={new QueryClient()}>
            <AuthProvider loadingFallback={fallback}>
                <Status />
            </AuthProvider>
        </QueryClientProvider>,
    );
}

test('the server render says the session is loading', () => {
    expect(serverRender()).toBe('<p>loading</p>');
});

test('the server render shows the children even when a loadingFallback is given', () => {
    expect(serverRender('Please wait')).toBe('<p>loading</p>');
});
