import type { ReactElement } from 'react';
import ReactDOM from 'react-dom/client';

// One React root per mount element, keyed by id, kept across module re-evaluations.
// Vite HMR re-runs main.tsx on every edit; without this cache a second
// `createRoot` on the same element triggers React's "You are calling
// ReactDOMClient.createRoot() on a container that has already been passed to
// createRoot() before" warning (and, on some HMR paths, a fatal removeChild).
const rootCache = new Map<string, ReactDOM.Root>();

// Mount a React app onto a container element, doing the right thing for both
// prerendered and SPA pages, and surviving Vite HMR re-evaluation.
//
// - HMR re-run: reuse the cached root and `.render()` again — no second
//   `createRoot`, so no double-root warning.
// - Prerendered page (container already holds server HTML, e.g. apps/index):
//   `hydrateRoot`, so React attaches to the existing markup instead of throwing
//   it away. The first client render MUST match that markup — for the index
//   site that is guaranteed by AuthProvider rendering children (signed-out)
//   on the first client render; the session resolves afterwards and swaps the
//   UI. Using `createRoot` here would discard the server HTML and (in the
//   incident) left the page dead.
// - SPA page (empty container, e.g. drive/mail/…): `createRoot`.
//
// Container emptiness is decided with `hasChildNodes()`: every app's
// `index.html` ships `<div id="app"></div>` (no whitespace), so it is false for
// SPAs and true only once the index prerender injects the app body.
export function mountReactApp(elementId: string, component: ReactElement): void {
    const rootElement = document.getElementById(elementId);

    if (!rootElement) {
        console.warn(`Element with id "${elementId}" not found.`);
        return;
    }

    const cached = rootCache.get(elementId);
    if (cached) {
        cached.render(component);
        return;
    }

    if (rootElement.hasChildNodes()) {
        rootCache.set(elementId, ReactDOM.hydrateRoot(rootElement, component));
    } else {
        const root = ReactDOM.createRoot(rootElement);
        root.render(component);
        rootCache.set(elementId, root);
    }
}
