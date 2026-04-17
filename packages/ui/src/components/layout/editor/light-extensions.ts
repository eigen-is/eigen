import StarterKit from '@tiptap/starter-kit';

export function getLightExtensions() {
    return [
        StarterKit.configure({
            heading: false,
            codeBlock: false,
            code: false,
            horizontalRule: false,
            link: {
                HTMLAttributes: {
                    target: '_blank',
                    rel: 'noopener noreferrer',
                },
            },
        }),
    ];
}
