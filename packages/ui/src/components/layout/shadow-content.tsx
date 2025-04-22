import React, {useEffect, useRef} from "react";
import {cn} from "../../lib/utils";

interface ShadowContentProps {
    content: string;
    className?: string;
    contentType?: "html" | "text";
}

/**
 * ShadowContent - Renders content within a Shadow DOM to isolate
 * styles and prevent them from affecting the rest of the application.
 * Uses 'closed' mode for better security when rendering untrusted content.
 */
export function ShadowContent({
                                  content,
                                  className,
                                  contentType = "html",
                                  ...props
                              }: ShadowContentProps & React.HTMLAttributes<HTMLDivElement>) {
    const shadowHostRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const hostElement = shadowHostRef.current;
        if (!hostElement) return;

        // Store reference to shadow root in a closure since we can't access it
        // after creation when using 'closed' mode
        let shadowRoot: ShadowRoot;

        // Check if we need to create a new shadow root
        if ((hostElement as any)._shadowRoot) {
            // We stored the reference in a property as we can't access it via shadowRoot in closed mode
            shadowRoot = (hostElement as any)._shadowRoot;
            // Clear previous content
            shadowRoot.innerHTML = "";
        } else {
            // Create new shadow root with "closed" mode for better security
            // @ts-ignore
            shadowRoot = hostElement.attachShadow({mode: "closed", clonable: true});
            // Store reference to the shadow root since we can't access it later with mode: "closed"
            (hostElement as any)._shadowRoot = shadowRoot;
        }

        // Create container for content
        const contentContainer = document.createElement("div");
        contentContainer.className = "shadow-content-container";

        // Add content based on type
        if (contentType === "html") {
            contentContainer.innerHTML = content;
        } else {
            contentContainer.textContent = content;
            contentContainer.style.whiteSpace = "pre-wrap";
        }

        // Add some base styles to maintain readability
        const styleElement = document.createElement("style");
        styleElement.textContent = `
      .shadow-content-container {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif;
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

    return (
        <div
            ref={shadowHostRef}
            className={cn("shadow-host", className)}
            {...props}
        />
    );
}
