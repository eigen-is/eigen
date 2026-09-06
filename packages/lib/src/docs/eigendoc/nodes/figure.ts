import { type CommandProps, Node } from '@tiptap/core';

export type FigureLayout = 'block' | 'wrap-left' | 'wrap-right';

// The node's attribute set, as it comes back off a stored document (every attr defaults to null).
export type FigureAttrs = {
    mediaName?: string | null;
    src?: string | null;
    alt?: string | null;
    caption?: string | null;
    width?: number | null;
    alignment?: string | null;
    layout?: FigureLayout | null;
};

declare module '@tiptap/core' {
    interface Commands<ReturnType> {
        figure: {
            setFigure: (options: FigureAttrs & { mediaName: string }) => ReturnType;
        };
    }
}

export const FigureNode = Node.create({
    name: 'figure',

    group: 'inline',

    inline: true,

    atom: true,

    draggable: true,

    addAttributes() {
        return {
            mediaName: { default: null },
            src: { default: null },
            alt: { default: null },
            caption: { default: null },
            width: {
                default: null,
                parseHTML: (element: HTMLElement) => {
                    const img = element.querySelector('img') || element;
                    const attr = img.getAttribute('width');
                    if (attr) return parseInt(attr, 10) || null;
                    const styleWidth = (img as HTMLElement).style?.width;
                    if (styleWidth?.endsWith('px')) return parseInt(styleWidth, 10) || null;
                    return null;
                },
            },
            alignment: { default: 'center' },
            layout: {
                default: 'block' as FigureLayout,
                parseHTML: (element: HTMLElement) => {
                    const attr = element.getAttribute('data-layout');
                    if (attr) return attr;
                    const float = element.style?.float;
                    if (float === 'left') return 'wrap-left';
                    if (float === 'right') return 'wrap-right';
                    return 'block';
                },
            },
        };
    },

    parseHTML() {
        return [
            {
                tag: 'figure',
                getAttrs(dom) {
                    const el = dom as HTMLElement;
                    const img = el.querySelector('img');
                    if (!img) return false;
                    const figcaption = el.querySelector('figcaption');
                    const layoutAttr = el.getAttribute('data-layout');
                    let layout: FigureLayout = 'block';
                    if (layoutAttr) {
                        layout = layoutAttr as FigureLayout;
                    } else {
                        const float = el.style?.float;
                        if (float === 'left') layout = 'wrap-left';
                        else if (float === 'right') layout = 'wrap-right';
                    }
                    return {
                        src: img.getAttribute('src'),
                        alt: img.getAttribute('alt'),
                        mediaName: img.getAttribute('data-media-name'),
                        caption: figcaption?.textContent || null,
                        alignment: el.getAttribute('data-alignment') || 'center',
                        layout,
                    };
                },
                priority: 60,
            },
            {
                tag: 'img[data-media-name]',
                priority: 51,
                getAttrs(dom) {
                    const el = dom as HTMLElement;
                    return {
                        mediaName: el.getAttribute('data-media-name'),
                        src: el.getAttribute('src'),
                        alt: el.getAttribute('alt'),
                    };
                },
            },
            {
                tag: 'img[src]',
                priority: 50,
                getAttrs(dom) {
                    const el = dom as HTMLElement;
                    return {
                        src: el.getAttribute('src'),
                        alt: el.getAttribute('alt'),
                    };
                },
            },
        ];
    },

    renderHTML({ HTMLAttributes }) {
        const figureAttrs: Record<string, unknown> = {};
        if (HTMLAttributes['alignment'] && HTMLAttributes['alignment'] !== 'center') {
            figureAttrs['data-alignment'] = HTMLAttributes['alignment'];
        }
        if (HTMLAttributes['layout'] && HTMLAttributes['layout'] !== 'block') {
            figureAttrs['data-layout'] = HTMLAttributes['layout'];
        }
        const imgAttrs: Record<string, unknown> = {
            src: HTMLAttributes['src'],
            alt: HTMLAttributes['alt'],
        };
        if (HTMLAttributes['data-media-name'] || HTMLAttributes['mediaName']) {
            imgAttrs['data-media-name'] = HTMLAttributes['data-media-name'] || HTMLAttributes['mediaName'];
        }
        if (HTMLAttributes['width']) {
            imgAttrs['width'] = HTMLAttributes['width'];
        }

        if (HTMLAttributes['caption']) {
            return ['figure', figureAttrs, ['img', imgAttrs], ['figcaption', {}, HTMLAttributes['caption']]];
        }
        return ['figure', figureAttrs, ['img', imgAttrs]];
    },

    addCommands() {
        return {
            setFigure:
                (options) =>
                ({ commands }: CommandProps) => {
                    return commands.insertContent({
                        type: this.name,
                        attrs: options,
                    });
                },
        };
    },
});
