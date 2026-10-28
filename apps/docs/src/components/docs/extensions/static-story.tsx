// A closed story drawn as the schema writes its paragraphs, a note in the notes list or a text box in its frame, so a
// doc with many notes or boxes keeps one live editor, the open story's. Its images resolve as the figure's node view's
// do.

import type { Node as PMNode } from '@tiptap/pm/model';
import { DOMSerializer } from '@tiptap/pm/model';
import { useMediaResolver } from '@workspace/lib/drive';
import { memo, useLayoutEffect, useRef } from 'react';

export const StaticStory = memo(function StaticStory({ node, className }: { node: PMNode; className: string }) {
    const ref = useRef<HTMLDivElement>(null);
    const { resolveMediaUrl } = useMediaResolver();
    useLayoutEffect(() => {
        const fragment = DOMSerializer.fromSchema(node.type.schema).serializeFragment(node.content);
        for (const img of fragment.querySelectorAll('img[data-media-name]')) {
            const src = resolveMediaUrl(img.getAttribute('data-media-name') ?? '');
            if (src) img.setAttribute('src', src);
        }
        ref.current?.replaceChildren(fragment);
    }, [node, resolveMediaUrl]);
    return <div ref={ref} className={className} />;
});
