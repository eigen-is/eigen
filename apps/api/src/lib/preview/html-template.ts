export function wrapHtml(body: string, title: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

:root {
    --fg: #1a1a2e;
    --bg: #ffffff;
    --bg-code: #f5f5f7;
    --border: #e0e0e6;
    --fg-muted: #6b7280;
    --link: #2563eb;
    --fg-code: #1a1a2e;
}

@media (prefers-color-scheme: dark) {
    :root {
        --fg: #e4e4e7;
        --bg: #18181b;
        --bg-code: #27272a;
        --border: #3f3f46;
        --fg-muted: #a1a1aa;
        --link: #60a5fa;
        --fg-code: #e4e4e7;
    }
}

body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 15px;
    line-height: 1.7;
    color: var(--fg);
    background: var(--bg);
    padding: 2rem;
    max-width: 52rem;
    margin: 0 auto;
}

/* Prose */
h1, h2, h3, h4, h5, h6 { margin-top: 1.5em; margin-bottom: 0.5em; font-weight: 600; line-height: 1.3; }
h1 { font-size: 1.75em; }
h2 { font-size: 1.4em; }
h3 { font-size: 1.15em; }
p { margin-bottom: 1em; }
a { color: var(--link); text-decoration: none; }
a:hover { text-decoration: underline; }
ul, ol { margin-bottom: 1em; padding-left: 1.5em; }
li { margin-bottom: 0.25em; }
blockquote { border-left: 3px solid var(--border); padding-left: 1em; color: var(--fg-muted); margin-bottom: 1em; }
hr { border: none; border-top: 1px solid var(--border); margin: 1.5em 0; }
img { max-width: 100%; height: auto; border-radius: 4px; }
table { border-collapse: collapse; width: 100%; margin-bottom: 1em; }
th, td { border: 1px solid var(--border); padding: 0.4em 0.8em; text-align: left; }
th { background: var(--bg-code); font-weight: 600; }

/* Code */
code {
    font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', Consolas, monospace;
    font-size: 0.9em;
    background: var(--bg-code);
    color: var(--fg-code);
    padding: 0.15em 0.35em;
    border-radius: 3px;
}
pre {
    background: var(--bg-code);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 1em;
    overflow-x: auto;
    margin-bottom: 1em;
    line-height: 1.5;
}
pre code {
    background: none;
    padding: 0;
    border-radius: 0;
    font-size: 0.85em;
}

/* Syntax highlighting (lowlight) */
.hljs-comment, .hljs-quote { color: var(--fg-muted); font-style: italic; }
.hljs-keyword, .hljs-selector-tag, .hljs-addition { color: #c678dd; }
.hljs-string, .hljs-doctag, .hljs-regexp { color: #98c379; }
.hljs-number, .hljs-literal { color: #d19a66; }
.hljs-title, .hljs-section, .hljs-selector-id { color: #e06c75; }
.hljs-function .hljs-title { color: #61afef; }
.hljs-type, .hljs-built_in { color: #e5c07b; }
.hljs-attr, .hljs-variable, .hljs-template-variable { color: #61afef; }
.hljs-attribute { color: #98c379; }
.hljs-meta { color: var(--fg-muted); }
.hljs-deletion { color: #e06c75; }
.hljs-symbol, .hljs-bullet { color: #56b6c2; }

@media (prefers-color-scheme: dark) {
    .hljs-keyword, .hljs-selector-tag, .hljs-addition { color: #c678dd; }
    .hljs-string, .hljs-doctag, .hljs-regexp { color: #98c379; }
    .hljs-number, .hljs-literal { color: #d19a66; }
    .hljs-title, .hljs-section, .hljs-selector-id { color: #e06c75; }
    .hljs-function .hljs-title { color: #61afef; }
    .hljs-type, .hljs-built_in { color: #e5c07b; }
    .hljs-attr, .hljs-variable, .hljs-template-variable { color: #61afef; }
}
</style>
</head>
<body>
${body}
</body>
</html>`;
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
