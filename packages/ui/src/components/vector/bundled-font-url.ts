/// <reference types="vite/client" />
// A bundled face's file as the build serves it, by its path under assets/fonts/: the same hashed file the fonts.css
// @font-face rules load, so a downloaded image embeds what the canvas drew with.

export function bundledFontUrl(file: string): string {
    const urls = import.meta.glob<string>('../../assets/fonts/*/*.woff2', {
        query: '?url',
        import: 'default',
        eager: true,
    });
    return urls[`../../assets/fonts/${file}`];
}
