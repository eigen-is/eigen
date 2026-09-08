import { createHash } from 'node:crypto';

// The inline theme-flash script injected into every app's <head> by vite.shared.config.ts.
// It is the single source: the CSP script-src hash below is computed from these exact bytes,
// so the two can never drift. Keep in sync with applyTheme/getCachedTheme in theme-provider.tsx.
export const THEME_FLASH_SCRIPT =
    'try{var t=localStorage.getItem("eigen-theme");var d=t==="dark"||(t==="system"&&matchMedia("(prefers-color-scheme:dark)").matches);if(d)document.documentElement.classList.add("dark")}catch{}';

// CSP source expression for the inline theme script, hashed over its exact textContent.
export function themeScriptCspSource(): string {
    return `'sha256-${createHash('sha256').update(THEME_FLASH_SCRIPT).digest('base64')}'`;
}

interface SecurityPolicyOptions {
    // Vite serve (dev) vs build (prod). In dev each app is served from its own :30xx origin and the
    // API is a separate cross-origin http://localhost:8000; in prod the API is same-origin under /eigen.
    dev: boolean;
    // The client's VITE_API_HOST. Absolute in dev, relative ("/eigen") or empty in prod.
    apiHost: string;
}

// Build the Content-Security-Policy served as a <meta> in every app shell, so every deployment shape
// (edge Caddy, static bundle, host proxies, dev) inherits one policy. Prod stays tight: same-origin
// scripts pinned by the theme-script hash, no inline script. Dev opens only what Vite's dev server and
// the cross-origin API demand — see the per-directive notes below.
export function buildContentSecurityPolicy({ dev, apiHost }: SecurityPolicyOptions): string {
    // 'self' + hashed theme script in prod. In dev, Vite's react-refresh preamble and HMR client are
    // inline scripts; a hash cannot cover them, and adding 'unsafe-inline' alongside a hash makes the
    // browser ignore 'unsafe-inline'. So dev drops the hash and allows inline instead.
    const script = dev ? "'self' 'unsafe-inline'" : `'self' ${themeScriptCspSource()}`;
    // https: lets sanitized mail bodies (rendered in a srcdoc iframe that inherits this policy) load
    // remote images; data:/blob: cover generated thumbnails, avatars and object URLs.
    const img = ["'self'", 'data:', 'blob:', 'https:'];
    const media = ["'self'", 'blob:', 'data:'];
    // Preview iframes and the srcdoc mail body.
    const frame = ["'self'", 'blob:'];
    // xhr, SSE and the ws collab socket. All same-origin in prod ('self' covers ws to the same origin).
    const connect = ["'self'"];

    if (dev && /^https?:\/\//.test(apiHost)) {
        const { origin } = new URL(apiHost);
        // The cross-origin dev API must be reachable for xhr/SSE (connect), the ws collab socket
        // (connect), preview iframes (frame), thumbnails/avatars (img) and audio/video embeds (media).
        connect.push(origin, origin.replace(/^http/, 'ws'));
        frame.push(origin);
        img.push(origin);
        media.push(origin);
    }

    return [
        "default-src 'self'",
        `script-src ${script}`,
        // <style> tags and style="" attributes: Vite injects styles inline in dev, and runtime UI libs
        // inject <style> in prod. React's style={{}} sets the CSSOM, which style-src does not govern.
        "style-src 'self' 'unsafe-inline'",
        `img-src ${img.join(' ')}`,
        `media-src ${media.join(' ')}`,
        "font-src 'self' data:",
        `connect-src ${connect.join(' ')}`,
        `frame-src ${frame.join(' ')}`,
        "worker-src 'self' blob:",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
    ].join('; ');
}

// The <meta> tags injected into every app's <head>. frame-ancestors is deliberately absent — it is
// ignored in a meta CSP; the edge X-Frame-Options header covers clickjacking instead.
export function buildSecurityMetaTags(options: SecurityPolicyOptions): string {
    const csp = buildContentSecurityPolicy(options);
    return `<meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="strict-origin-when-cross-origin">`;
}

// Executable inline scripts: no src, and no type other than a JavaScript one. JSON and ld+json
// script blocks are data, which script-src does not govern.
const INLINE_SCRIPT = /<script(?![^>]*\ssrc=)([^>]*)>([\s\S]*?)<\/script>/g;
const NON_JS_TYPE = /\stype=["'](?!(?:module|text\/javascript|application\/javascript)["'])/i;

// Pin every executable inline script in an assembled page to the page's CSP meta. The index app's
// prerender appends TanStack Router's dehydration scripts, whose content differs per page, so the
// hashes can only be computed once the page is final. Hashes already present (the theme script) are
// kept; a page without a CSP meta is returned unchanged.
export function withInlineScriptHashes(html: string): string {
    const hashes: string[] = [];
    for (const [, attrs, body] of html.matchAll(INLINE_SCRIPT)) {
        if (NON_JS_TYPE.test(attrs)) continue;
        hashes.push(`'sha256-${createHash('sha256').update(body).digest('base64')}'`);
    }
    return html.replace(/(<meta http-equiv="Content-Security-Policy" content="[^"]*?script-src[^;"]*)/, (directive) => {
        const missing = hashes.filter((hash) => !directive.includes(hash));
        return missing.length === 0 ? directive : `${directive} ${missing.join(' ')}`;
    });
}
