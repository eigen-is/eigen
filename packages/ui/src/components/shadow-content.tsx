import type React from 'react';
import { useEffect, useRef } from 'react';
import { cn } from '../lib/utils';

const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g;

// Wrap case-insensitive literal matches of `term` under `root` in <mark class="search-highlight">
// and scroll the first into view. Literal (no option toggles) — mail's ?q= landing has no find
// bar. Runs inside the closed shadow root we own; the mark style is injected with the content
// (see styleElement below), since app CSS can't reach across the boundary.
function highlightMatches(root: HTMLElement, term: string): void {
    const regex = new RegExp(term.replace(REGEX_SPECIALS, '\\$&'), 'gi');
    // Sanitized email HTML keeps <style> elements — a <mark> around "red"/"10px" mid-rule would
    // corrupt the email's CSS. Skip text under non-rendered elements.
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: (n) =>
            n.parentElement?.closest('style,script,title') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    });
    const targets: Text[] = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (n.nodeValue && regex.test(n.nodeValue)) targets.push(n as Text);
        regex.lastIndex = 0;
    }
    let first: HTMLElement | null = null;
    for (const textNode of targets) {
        const text = textNode.nodeValue ?? '';
        const frag = document.createDocumentFragment();
        let last = 0;
        regex.lastIndex = 0;
        for (let m = regex.exec(text); m; m = regex.exec(text)) {
            if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
            const mark = document.createElement('mark');
            mark.className = 'search-highlight';
            mark.textContent = m[0];
            if (!first) first = mark;
            frag.appendChild(mark);
            last = m.index + m[0].length;
            if (m[0].length === 0) regex.lastIndex++;
        }
        if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
        textNode.parentNode?.replaceChild(frag, textNode);
    }
    first?.scrollIntoView({ block: 'center' });
}

type ShadowContentProps = {
    content: string;
    className?: string;
    contentType?: 'html' | 'text';
    // Author-styled HTML (real formatted mail) is written against a light background but
    // rarely declares one, so explicit text colors go dark-on-dark in the dark theme.
    // 'light' renders it on a light canvas regardless of app theme (what mail clients do);
    // 'theme' keeps unstyled/derived content theme-native.
    scheme?: 'light' | 'theme';
    // A ?q= landing term: literal matches in the rendered body are wrapped in <mark> and the
    // first is scrolled into view. Highlighting lives here because the shadow root is closed.
    highlightTerm?: string;
};

// HTML content is sanitized server-side using DOMPurify before storage.
// Shadow DOM provides style isolation; script isolation is handled by BE sanitization.
export function ShadowContent({
    content,
    className,
    contentType = 'html',
    scheme = 'theme',
    highlightTerm,
    ...props
}: ShadowContentProps & React.HTMLAttributes<HTMLDivElement>) {
    const shadowHostRef = useRef<HTMLDivElement>(null);
    const shadowRootRef = useRef<ShadowRoot | null>(null);

    // Sync shadow DOM color-scheme with the app theme (.dark class on <html>)
    useEffect(() => {
        const hostElement = shadowHostRef.current;
        if (!hostElement) return;

        if (scheme === 'light') {
            hostElement.style.colorScheme = 'light';
            return;
        }

        const syncTheme = () => {
            const isDark = document.documentElement.classList.contains('dark');
            hostElement.style.colorScheme = isDark ? 'dark' : 'light';
        };

        syncTheme();

        const observer = new MutationObserver(syncTheme);
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
        return () => observer.disconnect();
    }, [scheme]);

    useEffect(() => {
        const hostElement = shadowHostRef.current;
        if (!hostElement) return;

        if (shadowRootRef.current) {
            shadowRootRef.current.innerHTML = '';
        } else {
            shadowRootRef.current = hostElement.attachShadow({ mode: 'closed', clonable: true } as ShadowRootInit);
        }

        const shadowRoot = shadowRootRef.current;

        // Create container for content
        const contentContainer = document.createElement('div');
        contentContainer.className = 'shadow-content-container';

        // Add content based on type
        if (contentType === 'html') {
            contentContainer.innerHTML = content;

            // Strip @media (prefers-color-scheme) blocks that conflict with the rendered
            // canvas. The media queries check the OS preference, not what we render on:
            // a forced-light canvas must drop the dark blocks; theme-native content drops
            // whichever side disagrees with the app theme.
            const renderDark = scheme === 'theme' && document.documentElement.classList.contains('dark');
            const removeScheme = renderDark ? 'light' : 'dark';
            const mqRegex = new RegExp(
                `@media\\s*\\([^)]*prefers-color-scheme:\\s*${removeScheme}[^)]*\\)\\s*\\{[^{}]*(?:\\{[^{}]*\\}[^{}]*)*\\}`,
                'gi',
            );
            for (const style of contentContainer.querySelectorAll('style')) {
                if (!style.textContent) continue;
                style.textContent = style.textContent.replace(mqRegex, '');
            }
        } else {
            contentContainer.textContent = content;
            contentContainer.style.whiteSpace = 'pre-wrap';
        }

        // Add some base styles to maintain readability
        const styleElement = document.createElement('style');
        styleElement.textContent = `
      .shadow-content-container {
        font-family: var(--font-sans, 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
        color: light-dark(#333, #e8eaed);
        line-height: 1.5;
        ${scheme === 'light' ? 'background: #fff; padding: 16px; border-radius: 8px;' : ''}
      }
      a { color: #2563eb; text-decoration: none; }
      a:hover { text-decoration: underline; }
      img { max-width: 100%; height: auto; }
      mark.search-highlight { background-color: #fde047; color: #1f2937; border-radius: 2px; }

      /* Add prose-like styling for better readability */
      p, ul, ol, blockquote { margin-bottom: 1em; }
      h1, h2, h3, h4, h5, h6 { margin-top: 1.5em; margin-bottom: 0.5em; font-weight: 500; }
    `;

        // Append style and content to shadow DOM
        shadowRoot.appendChild(styleElement);
        shadowRoot.appendChild(contentContainer);

        if (highlightTerm) highlightMatches(contentContainer, highlightTerm);
    }, [content, contentType, scheme, highlightTerm]);

    return <div ref={shadowHostRef} className={cn('shadow-host', className)} {...props} />;
}
