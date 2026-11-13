// The textStyle mark's `fontFamily` attribute, as getDocExtensions gives it to the editor and the API's export
// alike. It stores an EIGEN_FONTS name, the canon shared with slides and vector, not a CSS stack: parseHTML turns a
// pasted or imported font into its name, and renderHTML turns the name into its stack. A stored stack draws as it
// is, as a collab doc hydrates through y-prosemirror and never runs parseHTML. A run draws its line at its font's own
// single line, as Word and Google Docs do, in the line spacing of the text block around it. The rest is the stock
// extension's.

import { FontFamily } from '@tiptap/extension-text-style';
import { fontLineHeight, fontNameToCss, getFontName } from '../../../constants/fonts';
import { LINE_SPACING_PROPERTY } from '../paragraph-format';

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
                            const fontLine = fontLineHeight(getFontName(value));
                            return {
                                style: `font-family: ${fontNameToCss(value)}; line-height: calc(var(${LINE_SPACING_PROPERTY}) * ${fontLine})`,
                            };
                        },
                    },
                },
            },
        ];
    },
});
