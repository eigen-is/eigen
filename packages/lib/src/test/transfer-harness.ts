// The environment the three import-hook tests share: a DOM to render into, a signed-in user, a toast
// recorder and a fetch recorder. Each file mocks the Eden client it needs on top of this, because only
// the route differs.
//
// Call `installTransferHarness()` at module scope, the way `installHappyDom()` is called: the window and
// the mocks belong to the file that installs them and are put back when that file is done.
import { afterAll, mock } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import { installHappyDom } from './happy-dom';

export const OWNER = 'a1b2c3d4';

// biome-ignore lint/suspicious/noExplicitAny: test-only globalThis injection
const g = globalThis as any;

// What sonner and fetch were handed, in order. Cleared per test by the file that reads them.
export const toasts: string[] = [];
export const fetchCalls: { url: string; body: BodyInit | null | undefined }[] = [];

// The JSON the recorded fetch answers with: an import route's counts, or the bytes step's body.
export const served: { importResponse: unknown } = { importResponse: null };

// Captured once, before any file has mocked anything, so a later file restores the real modules.
const realAuthContextModule = await import('../core/auth/auth-context');
const realSonnerModule = await import('sonner');
const realFetch = g.fetch;

export function installTransferHarness(): void {
    // react-dom needs a DOM to render the hooks into.
    installHappyDom();

    // The hooks read the signed-in user from the auth context; there is no provider here.
    mock.module('../core/auth/auth-context', () => ({
        useAuth: () => ({ user: { id: OWNER } }),
    }));

    // The toasts are what these files are about, so sonner is swapped for a recorder.
    mock.module('sonner', () => ({
        toast: {
            success: (message: string) => toasts.push(`success: ${message}`),
            error: (message: string) => toasts.push(`error: ${message}`),
        },
    }));

    g.fetch = async (url: string, init?: RequestInit) => {
        fetchCalls.push({ url, body: init?.body });
        return new Response(JSON.stringify(served.importResponse), { status: 200 });
    };

    afterAll(() => {
        g.fetch = realFetch;
        mock.module('../core/auth/auth-context', () => realAuthContextModule);
        mock.module('sonner', () => realSonnerModule);
    });
}

// Records every queryKey invalidated, so a test can assert which caches an import revives.
export function trackingClient(): { queryClient: QueryClient; invalidated: readonly unknown[][] } {
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const invalidated: unknown[][] = [];
    const original = queryClient.invalidateQueries.bind(queryClient);
    queryClient.invalidateQueries = ((filters?: { queryKey?: readonly unknown[] }) => {
        if (filters?.queryKey) invalidated.push([...filters.queryKey]);
        return original(filters as never);
    }) as typeof queryClient.invalidateQueries;
    return { queryClient, invalidated };
}

export function hasKey(keys: readonly unknown[][], expected: readonly unknown[]): boolean {
    return keys.some((key) => JSON.stringify(key) === JSON.stringify(expected));
}

// One React root for every hook that has to be rendered to be observed.
export async function renderHook<T>(
    use: () => T,
    queryClient: QueryClient,
): Promise<{ latest: T; unmount: () => void }> {
    const { act, createElement } = await import('react');
    const { createRoot } = await import('react-dom/client');
    const { QueryClientProvider } = await import('@tanstack/react-query');

    const seen: { latest: T | null } = { latest: null };
    function Harness() {
        seen.latest = use();
        return null;
    }
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => {
        root.render(createElement(QueryClientProvider, { client: queryClient }, createElement(Harness, null)));
    });
    return { latest: seen.latest as T, unmount: () => root.unmount() };
}
