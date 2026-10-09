import { Extension, isMarkActive } from '@tiptap/core';

// Word's w:caps and w:smallCaps: capitals drawn over the letters as typed. One attribute, as the two exclude each other.
export type Caps = 'all' | 'small';

declare module '@tiptap/core' {
    interface Commands<ReturnType> {
        caps: {
            setCaps: (caps: Caps) => ReturnType;
            unsetCaps: () => ReturnType;
            toggleCaps: (caps: Caps) => ReturnType;
        };
    }
}

// The longhand, as the shorthand font-variant would turn the editor's ligatures back on.
const CAPS_STYLE: Record<Caps, string> = {
    all: 'text-transform: uppercase',
    small: 'font-variant-caps: small-caps',
};

export const TextCaps = Extension.create({
    name: 'caps',

    addGlobalAttributes() {
        return [
            {
                types: ['textStyle'],
                attributes: {
                    caps: {
                        default: null,
                        parseHTML: (element): Caps | null => {
                            const { textTransform, fontVariant, fontVariantCaps } = element.style;
                            if (textTransform === 'uppercase') return 'all';
                            return fontVariantCaps === 'small-caps' || fontVariant === 'small-caps' ? 'small' : null;
                        },
                        renderHTML: (attributes) => {
                            const caps: unknown = attributes['caps'];
                            return caps === 'all' || caps === 'small' ? { style: CAPS_STYLE[caps] } : {};
                        },
                    },
                },
            },
        ];
    },

    addCommands() {
        return {
            setCaps:
                (caps) =>
                ({ chain }) =>
                    chain().setMark('textStyle', { caps }).run(),
            unsetCaps:
                () =>
                ({ chain }) =>
                    chain().setMark('textStyle', { caps: null }).removeEmptyTextStyle().run(),
            toggleCaps:
                (caps) =>
                ({ state, commands }) =>
                    isMarkActive(state, 'textStyle', { caps }) ? commands.unsetCaps() : commands.setCaps(caps),
        };
    },

    // Word's all caps; its small caps key, Mod-Shift-K, opens the command palette.
    addKeyboardShortcuts() {
        return {
            'Mod-Shift-a': () => this.editor.commands.toggleCaps('all'),
        };
    },
});
