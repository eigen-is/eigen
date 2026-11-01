// ShadowContent draws HTML that someone else wrote, such as a mail message, inside a closed shadow root, so the
// sender's CSS can't reach the app and the app's can't reach the message. It sets a readable base style in the app's
// font, follows the app theme or forces a light canvas, scales a too-wide layout down to fit, and highlights a search
// term. Every caller, such as the mail reading pane, passes a body the API sanitized with DOMPurify, so scripts are
// the server's concern. The text is never rewritten here: the theme rules and the highlight change the parsed tree.

import type React from 'react';
import { useEffect, useRef } from 'react';
import { cn } from '../lib/utils';

type ShadowContentProps = {
    content: string;
    className?: string;
    contentType?: 'html' | 'text';
    // A formatted mail is written for a light background but rarely sets one, so its own text colors would
    // draw dark on dark in the dark theme. 'light' draws it on a light canvas whatever the app theme, as mail
    // clients do. 'theme' follows the app theme, for content that sets no colors of its own.
    scheme?: 'light' | 'theme';
    // The term a ?q= link lands with. The highlight lives here because the shadow root is closed.
    highlightTerm?: string;
};

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
            shadowRootRef.current = hostElement.attachShadow({ mode: 'closed', clonable: true });
        }

        const shadowRoot = shadowRootRef.current;

        const contentContainer = document.createElement('div');
        contentContainer.className = 'shadow-content-container';

        if (contentType === 'html') {
            contentContainer.innerHTML = content;
        } else {
            contentContainer.textContent = content;
            contentContainer.style.whiteSpace = 'pre-wrap';
        }

        const styleElement = document.createElement('style');
        styleElement.textContent = `
      .shadow-content-container {
        font-family: var(--font-sans);
        color: light-dark(#333, #e8eaed);
        line-height: 1.5;
        /* fit-content gives the content's natural width, which the scale-to-fit below reads. A mail
           with a fixed-width layout is wider than the host, and text that wraps is as wide as the host.
           overflow-wrap keeps one long word, such as a URL, from widening that measurement. */
        width: fit-content;
        min-width: 100%;
        box-sizing: border-box;
        overflow-wrap: anywhere;
        ${scheme === 'light' ? 'background: #fff; padding: var(--shadow-card-padding, 0px); border-radius: var(--shadow-card-radius, 0px);' : ''}
      }
      a { color: #2563eb; text-decoration: none; }
      a:hover { text-decoration: underline; }
      img { max-width: 100%; height: auto; }
      mark.search-highlight { background-color: #fde047; color: #1f2937; border-radius: 2px; }

      p, ul, ol, blockquote { margin-bottom: 1em; }
      h1, h2, h3, h4, h5, h6 { margin-top: 1.5em; margin-bottom: 0.5em; font-weight: var(--font-weight-medium); }
    `;

        shadowRoot.appendChild(styleElement);
        shadowRoot.appendChild(contentContainer);

        // A forced-light canvas drops the mail's dark rules whatever the app theme. Content that follows the
        // theme drops the rules of the other side. This runs only now, because a style element parses no
        // sheet until it is in a tree.
        const renderDark = scheme === 'theme' && document.documentElement.classList.contains('dark');
        for (const style of contentContainer.querySelectorAll('style')) {
            if (style.sheet) dropColorSchemeRules(style.sheet, renderDark ? 'light' : 'dark');
        }

        // Content wider than the host is scaled down to fit instead of overflowing, as on the doc canvas.
        // The offset* sizes ignore the transform, so the observer never triggers itself. The negative
        // margin takes back the height the scale removed.
        const fitToHost = () => {
            // All reads before all writes: an offset* read after a style write forces a layout flush.
            const hostWidth = hostElement.offsetWidth;
            const hostHeight = hostElement.offsetHeight;
            if (hostWidth === 0) return;
            const scale = Math.min(1, hostWidth / contentContainer.offsetWidth);
            if (scale < 1) {
                hostElement.style.transform = `scale(${scale})`;
                hostElement.style.transformOrigin = 'top left';
                hostElement.style.marginBottom = `${-(1 - scale) * hostHeight}px`;
            } else {
                hostElement.style.transform = '';
                hostElement.style.marginBottom = '';
            }
        };
        // Fit before the highlight scrolls, so scrollIntoView sees the scaled layout and not the one the
        // observer is about to shrink.
        fitToHost();
        if (highlightTerm) highlightMatches(contentContainer, highlightTerm);

        const resizeObserver = new ResizeObserver(fitToHost);
        resizeObserver.observe(hostElement);
        resizeObserver.observe(contentContainer);
        return () => resizeObserver.disconnect();
    }, [content, contentType, scheme, highlightTerm]);

    return <div ref={shadowHostRef} className={cn('shadow-host', className)} {...props} />;
}

const COLOR_SCHEME_CONDITION = {
    light: /prefers-color-scheme\s*:\s*light/i,
    dark: /prefers-color-scheme\s*:\s*dark/i,
};

// A prefers-color-scheme query reads the OS setting, not the canvas the mail draws on. So the rules for the other
// scheme are deleted, through the CSSOM and never in the style text. Cutting a span out of sanitized text can join
// its neighbors into a token the server refused.
function dropColorSchemeRules(parent: CSSStyleSheet | CSSGroupingRule, scheme: 'light' | 'dark') {
    for (let i = parent.cssRules.length - 1; i >= 0; i--) {
        const rule = parent.cssRules[i];
        if (rule instanceof CSSMediaRule && COLOR_SCHEME_CONDITION[scheme].test(rule.conditionText))
            parent.deleteRule(i);
        else if (rule instanceof CSSGroupingRule) dropColorSchemeRules(rule, scheme);
    }
}

const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g;

// Wraps each match of `term` under `root` in <mark class="search-highlight"> and scrolls the first into view. A match
// ignores case and reads the term literally, because mail's ?q= landing has no find bar with options. App CSS can't
// reach into the shadow root, so the mark's look is in the style element ShadowContent adds beside the content.
function highlightMatches(root: HTMLElement, term: string) {
    const regex = new RegExp(term.replace(REGEX_SPECIALS, '\\$&'), 'gi');
    // Sanitized mail keeps its <style> elements, and a <mark> inside a rule would break the mail's CSS. So text under
    // an element that draws nothing is skipped.
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: (n) =>
            n.parentElement?.closest('style,script,title') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    });
    const targets: Text[] = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (n instanceof Text && n.nodeValue && regex.test(n.nodeValue)) targets.push(n);
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
