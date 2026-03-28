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
        } else {
            contentContainer.textContent = content;
            contentContainer.style.whiteSpace = 'pre-wrap';
        }

        // Add some base styles to maintain readability
        const styleElement = document.createElement('style');
        styleElement.textContent = `
      .shadow-content-container {
        font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        color: #333;
        line-height: 1.5;
      }
      a { color: #0066cc; }
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
