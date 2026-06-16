import ReactDOM from 'react-dom/client';

const rootCache = new Map<string, ReactDOM.Root>();

/**
 * Safely creates or retrieves a React root using an in-memory cache.
 */
export function mountReactApp(elementId: string, Component: React.ReactElement): void {
    const rootElement = document.getElementById(elementId);

    if (!rootElement) {
        console.warn(`Element with id "${elementId}" not found.`);
        return;
    }

    if (!rootElement.innerHTML || rootCache.has(elementId)) {
        let root = rootCache.get(elementId);
        if (!root) {
            root = ReactDOM.createRoot(rootElement);
            rootCache.set(elementId, root);
        }
        root.render(Component);
    }
}
