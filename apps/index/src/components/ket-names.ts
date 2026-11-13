// Eigen writes an app's name as a ket, such as eigen|mail⟩, and the public site sets each one in its mono font.
// This splits text around those names, for the Markdown renderer at build time and for a media grid's captions.

// The capture group keeps the names in the result, at the odd indices.
const KET_NAME = /(eigen\|[a-z]+⟩)/;

export function splitKetNames(text: string): string[] {
    return text.split(KET_NAME);
}
