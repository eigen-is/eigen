import { createMemoryHistory } from '@tanstack/react-router';
import { attachRouterServerSsrUtils, RouterServer } from '@tanstack/react-router/ssr/server';
import { renderToString } from 'react-dom/server';
import { type PageArticle, setPrerenderBody } from './content/manifest';
import { createAppRouter } from './router';

// SSR entry — renders one route to HTML and produces TanStack Router's
// dehydration <script>. Loaded by scripts/prerender.tsx through Vite's
// ssrLoadModule. `article` is the page's own body — the prerender hands it in
// so the route component can render it synchronously (the server has no DOM to
// read it from).
//
// We follow TanStack's canonical SSR handshake (see createRequestHandler +
// renderRouterToString in @tanstack/router-core / @tanstack/react-router):
//   load → dehydrate → renderToString(<RouterServer/>) → setRenderFinished →
//   takeBufferedHtml. Emitting the dehydrated router state on `window.$_TSR`
//   lets RouterClient hydrate the matched tree IN PLACE, reproducing the same
//   React.Suspense boundary the server emits around the <Outlet/>. Without it
//   the client renders a different tree shape (no Suspense markers) and React
//   discards the prerendered DOM, mounting a second copy beside it.
export async function render(
    url: string,
    article: PageArticle | null,
): Promise<{ appHtml: string; dehydrationHtml: string }> {
    setPrerenderBody(article);
    const router = createAppRouter(createMemoryHistory({ initialEntries: [url] }));
    // manifest is undefined: this app has no SSR route-asset manifest. dehydrate
    // only walks manifest.routes when a manifest is given (ssr-server.ts), so
    // undefined is the correct minimal value — the dehydrated payload carries
    // `manifest: void 0` and hydration reads no per-route assets.
    attachRouterServerSsrUtils({ router, manifest: undefined });
    // attachRouterServerSsrUtils always assigns router.serverSsr; the router type
    // marks it optional because it is populated post-construction, so narrow once.
    const { serverSsr } = router;
    if (!serverSsr) throw new Error('attachRouterServerSsrUtils did not attach serverSsr');
    await router.load();
    // Dehydrate BEFORE the render so the serialized matches are queued, then the
    // render walks the same matches and emits the Suspense boundary.
    await serverSsr.dehydrate();
    const appHtml = renderToString(<RouterServer router={router} />);
    // setRenderFinished lifts the script barrier; the buffered scripts are then
    // flushed to the injected-HTML buffer on a queueMicrotask (ScriptBuffer.
    // liftBarrier in ssr-server.ts). renderRouterToString calls takeBufferedHtml
    // synchronously because it returns a streamed Response; our non-streaming
    // prerender must await that one microtask first, or takeBufferedHtml() comes
    // back empty (verified empirically against the installed 1.168.2 source).
    serverSsr.setRenderFinished();
    await Promise.resolve();
    const dehydrationHtml = serverSsr.takeBufferedHtml() ?? '';
    serverSsr.cleanup();
    return { appHtml, dehydrationHtml };
}
