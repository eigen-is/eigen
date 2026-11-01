/// <reference types="vite/client" />
// A font slice's file as the build serves it, by its path among the font assets: the same hashed file the fonts.css
// @font-face rules load, so a downloaded image embeds what the canvas drew with. Each slice is one Vite URL in the
// map, so only the image download imports this module, when a download starts.

export function bundledFontUrl(file: string): string {
    // A slice's name has its label between the face's name and .woff2, and the whole face, the vendoring script's
    // input, has none, so the build emits no whole face. The math face is one whole file, and no canvas text draws in it.
    const urls = import.meta.glob<string>('../../assets/fonts/*/*.*.woff2', {
        query: '?url',
        import: 'default',
        eager: true,
    });
    const url = urls[`../../assets/fonts/${file}`];
    if (url === undefined) throw new Error(`No font slice ${file} is bundled`);
    return url;
}
