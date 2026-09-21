// The client never rewrites the CSS text the server sanitized. The server refuses a `<style>` on tokens
// (`url(`, `@import`), so deleting a span of text can splice the halves around it into the very token it
// refused: `ur` + `@media (prefers-color-scheme: dark){}` + `l(https://…)`. The unwanted color-scheme
// rules go through the CSSOM instead, where a split token is parsed as the garbage it is.
//
// The shadow root is closed, so the test borrows `attachShadow` to read what the component built.
import { expect, test } from 'bun:test';
import { installHappyDom } from '../happy-dom';

installHappyDom();

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { ShadowContent } = await import('../../components/shadow-content');

const URL_SPLIT =
    '<style>p{background:ur@media (prefers-color-scheme: dark){}l(https://example.com/eigen-tracking-pixel.png)}</style><p>hello</p>';
const IMPORT_SPLIT =
    '<style>@imp@media (prefers-color-scheme: dark){}ort url(https://example.com/evil.css);</style><p>hello</p>';

// Every rule the shadow root holds, the nested ones included.
function ruleTexts(root: ShadowRoot): string[] {
    const texts: string[] = [];
    const walk = (rules: CSSRuleList) => {
        for (const rule of rules) {
            texts.push(rule.cssText);
            if (rule instanceof CSSGroupingRule) walk(rule.cssRules);
        }
    };
    for (const style of root.querySelectorAll('style')) if (style.sheet) walk(style.sheet.cssRules);
    return texts;
}

function render(
    content: string,
    scheme?: 'light' | 'theme',
): { rules: string[]; styleTexts: string[]; cleanup: () => void } {
    const attach = HTMLElement.prototype.attachShadow;
    const captured: { root: ShadowRoot | null } = { root: null };
    HTMLElement.prototype.attachShadow = function attachShadowSpy(init: ShadowRootInit) {
        captured.root = attach.call(this, init);
        return captured.root;
    };
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
        act(() => root.render(createElement(ShadowContent, { content, scheme })));
    } finally {
        HTMLElement.prototype.attachShadow = attach;
    }
    const shadowRoot = captured.root;
    if (!shadowRoot) throw new Error('the component attached no shadow root');
    return {
        rules: ruleTexts(shadowRoot),
        styleTexts: [...shadowRoot.querySelectorAll('.shadow-content-container style')].map(
            (style) => style.textContent ?? '',
        ),
        cleanup: () => {
            act(() => root.unmount());
            container.remove();
        },
    };
}

test('a split url( token in a sanitized <style> is never reassembled', () => {
    const { rules, cleanup } = render(URL_SPLIT);
    expect(rules.some((text) => text.includes('example.com'))).toBe(false);
    cleanup();
});

test('the CSS text of a sanitized <style> is handed through untouched', () => {
    for (const content of [URL_SPLIT, IMPORT_SPLIT]) {
        const { styleTexts, cleanup } = render(content);
        expect(styleTexts).toEqual([content.slice('<style>'.length, content.indexOf('</style>'))]);
        cleanup();
    }
});

test('theme-native content keeps the color-scheme rules that agree with the app theme', () => {
    const content =
        '<style>@media (prefers-color-scheme: dark){p{color:#fff}}@media (prefers-color-scheme: light){p{color:#000}}</style><p>hi</p>';

    const light = render(content);
    expect(light.rules.some((text) => text.includes('prefers-color-scheme: light'))).toBe(true);
    expect(light.rules.some((text) => text.includes('prefers-color-scheme: dark'))).toBe(false);
    light.cleanup();

    document.documentElement.classList.add('dark');
    const dark = render(content);
    expect(dark.rules.some((text) => text.includes('prefers-color-scheme: dark'))).toBe(true);
    expect(dark.rules.some((text) => text.includes('prefers-color-scheme: light'))).toBe(false);
    dark.cleanup();
    document.documentElement.classList.remove('dark');
});

test('a forced-light canvas drops the dark rules whatever the app theme, nested ones included', () => {
    document.documentElement.classList.add('dark');
    const { rules, cleanup } = render(
        '<style>@supports (display:grid){@media (prefers-color-scheme: dark){p{color:#fff}}}@media (prefers-color-scheme: light){p{color:#000}}</style><p>hi</p>',
        'light',
    );
    expect(rules.some((text) => text.includes('prefers-color-scheme: dark'))).toBe(false);
    expect(rules.some((text) => text.includes('prefers-color-scheme: light'))).toBe(true);
    cleanup();
    document.documentElement.classList.remove('dark');
});
