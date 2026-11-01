/// <reference types="vite/client" />
// A font slice's file as the build serves it, by its path among the font assets: the same hashed file the fonts.css
// @font-face rules load, so a downloaded image embeds what the canvas drew with. The map holds one Vite URL per
// slice, so only the image download imports this module, and only when a download starts.

export function bundledFontUrl(file: string): string {
    // A slice's file name has a label between the face's name and .woff2, such as Excalifont-Regular.all.woff2. The
    // whole face, which the vendoring script cuts, has no label, so the build emits no whole face. The math face is
    // one whole file, and no canvas text draws in it.
    const urls = import.meta.glob<string>('../../assets/fonts/*/*.*.woff2', {
        query: '?url',
        import: 'default',
        eager: true,
    });
    const url = urls[`../../assets/fonts/${file}`];
    if (url === undefined) throw new Error(`No font slice ${file} is bundled`);
    return url;
}
