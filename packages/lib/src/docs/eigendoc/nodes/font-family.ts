import { FontFamily } from '@tiptap/extension-text-style';
import { fontNameToCss, getFontName } from '../../../constants/fonts';

// Docs stores the textStyle `fontFamily` attr as an EIGEN_FONTS *name* (the canon shared with
// slides and vector), not a full CSS stack. This override makes the mark tolerant at both seams:
//   - parseHTML (pasted HTML + docx import) canonicalizes an incoming CSS font-family to the name.
//   - renderHTML (the live editor DOM + the BE static export/preview renderer, both driven by
//     getDocExtensions) maps the name back to its CSS stack; a legacy value that is already a stack
//     passes through unchanged, so stored collab docs — which hydrate through y-prosemirror and
//     never run parseHTML — keep rendering byte-identically until the load-time normalizer collapses
//     them. Everything else (the `fontFamily`/`setFontFamily`/`unsetFontFamily` names, commands) is
//     inherited from the stock extension.
export const EigenFontFamily = FontFamily.extend({
    addGlobalAttributes() {
        return [
            {
                types: this.options.types,
                attributes: {
                    fontFamily: {
                        default: null,
                        parseHTML: (element) => {
                            const value = element.style.fontFamily;
                            return value ? getFontName(value) : null;
                        },
                        renderHTML: (attributes) => {
                            const value = attributes['fontFamily'];
                            if (!value || typeof value !== 'string') return {};
                            return { style: `font-family: ${fontNameToCss(value)}` };
                        },
                    },
                },
            },
        ];
    },
});
