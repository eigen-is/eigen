// The notes under the page, as Google's page-less document collects them at its end: each numbered, drawn as static
// HTML, and the open one as the note's live editor in its place. A press on a note opens it. StaticStory draws a
// closed text box's paragraphs the same way.

import type { Node as PMNode } from '@tiptap/pm/model';
import { DOMSerializer } from '@tiptap/pm/model';
import type { Editor } from '@tiptap/react';
import { EditorContent, useEditorState } from '@tiptap/react';
import { useMediaResolver } from '@workspace/lib/drive';
import { cn } from '@workspace/ui/lib/utils';
import { memo, useLayoutEffect, useRef } from 'react';
import { footnotesInDoc } from './extensions/footnote';
import type { StoryAnchor } from './extensions/story';
import { storyKey } from './extensions/story';

type FootnoteListProps = {
    body: Editor;
    // The note's live editor, drawn in place of the open note.
    note: Editor;
    open: StoryAnchor | null;
    // A writer's on a desktop or a tablet; a viewer and a phone read the notes.
    onOpen?: (pos: number, at: { left: number; top: number }) => void;
};

// A story as the schema writes it, so 133 notes are not 133 editors. Its images resolve as the figure's node view's do.
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

// The notes under the text, numbered and under a short rule, as Google's pageless document collects them at its end.
export function FootnoteList({ body, note, open, onOpen }: FootnoteListProps) {
    const notes = useEditorState({
        editor: body,
        selector: ({ editor }) => footnotesInDoc(editor),
        equalityFn: Object.is,
    });
    if (notes.length === 0) return null;
    return (
        <section data-footnotes className="footnote-list row-start-3">
            <ol>
                {notes.map(({ pos, node }, index) => (
                    <li key={storyKey(body, { pos, node })}>
                        <sup className="footnote-number">{index + 1}</sup>
                        {pos === open?.pos && open.type === 'footnote' ? (
                            <EditorContent editor={note} />
                        ) : (
                            <div
                                className={cn(onOpen && 'cursor-text')}
                                onMouseDown={
                                    onOpen &&
                                    ((event) => {
                                        event.preventDefault();
                                        onOpen(pos, { left: event.clientX, top: event.clientY });
                                    })
                                }
                            >
                                <StaticStory node={node} className="eigen-prose" />
                            </div>
                        )}
                    </li>
                ))}
            </ol>
        </section>
    );
}
