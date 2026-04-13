import type React from 'react';
import { useEffect, useRef } from 'react';
import { cn } from '../../lib/utils';

type ShadowContentProps = {
    content: string;
    className?: string;
    contentType?: 'html' | 'text';
};

// HTML content is sanitized server-side using DOMPurify before storage.
// Shadow DOM provides style isolation; script isolation is handled by BE sanitization.
export function ShadowContent({
    content,
    className,
    contentType = 'html',
    ...props
}: ShadowContentProps & React.HTMLAttributes<HTMLDivElement>) {
    const shadowHostRef = useRef<HTMLDivElement>(null);
    const shadowRootRef = useRef<ShadowRoot | null>(null);

    // Sync shadow DOM color-scheme with the app theme (.dark class on <html>)
    useEffect(() => {
        const hostElement = shadowHostRef.current;
        if (!hostElement) return;

        const syncTheme = () => {
            const isDark = document.documentElement.classList.contains('dark');
            hostElement.style.colorScheme = isDark ? 'dark' : 'light';
        };

        syncTheme();

        const observer = new MutationObserver(syncTheme);
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
        return () => observer.disconnect();
    }, []);

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

            // Strip email @media (prefers-color-scheme) rules that conflict with app theme.
            // prefers-color-scheme checks the OS preference, not the app theme, so emails
            // can apply dark-mode styles even when the app is in light mode (and vice versa).
            const isDark = document.documentElement.classList.contains('dark');
            const removeScheme = isDark ? 'light' : 'dark';
            for (const style of contentContainer.querySelectorAll('style')) {
                try {
                    const sheet = style.sheet;
                    if (!sheet) continue;
                    for (let i = sheet.cssRules.length - 1; i >= 0; i--) {
                        const rule = sheet.cssRules[i];
                        if (
                            rule instanceof CSSMediaRule &&
                            rule.conditionText.includes(`prefers-color-scheme: ${removeScheme}`)
                        ) {
                            sheet.deleteRule(i);
                        }
                    }
                } catch {
                    // CORS or parsing errors on inline styles — safe to ignore
                }
            }
        } else {
            contentContainer.textContent = content;
            contentContainer.style.whiteSpace = 'pre-wrap';
        }

        // Add some base styles to maintain readability
        const styleElement = document.createElement('style');
        styleElement.textContent = `
      .shadow-content-container {
        font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        color: light-dark(#333, #e8eaed);
        line-height: 1.5;
      }
      a { color: #2563eb; text-decoration: none; }
      a:hover { text-decoration: underline; }
      img { max-width: 100%; height: auto; }

      /* Add prose-like styling for better readability */
      p, ul, ol, blockquote { margin-bottom: 1em; }
      h1, h2, h3, h4, h5, h6 { margin-top: 1.5em; margin-bottom: 0.5em; font-weight: 600; }
    `;

        // Append style and content to shadow DOM
        shadowRoot.appendChild(styleElement);
        shadowRoot.appendChild(contentContainer);
    }, [content, contentType]);

    return <div ref={shadowHostRef} className={cn('shadow-host', className)} {...props} />;
}
