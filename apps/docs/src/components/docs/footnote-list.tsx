import { DOMSerializer, type Node as PMNode } from '@tiptap/pm/model';
import { type Editor, EditorContent, useEditorState } from '@tiptap/react';
import { useMediaResolver } from '@workspace/lib/drive';
import { cn } from '@workspace/ui/lib/utils';
import { memo, useLayoutEffect, useRef } from 'react';
import { footnotesInDoc, type NoteAnchor } from './extensions/footnote';

type FootnoteListProps = {
    body: Editor;
    // The note's live editor, drawn in place of the open note.
    note: Editor;
    open: NoteAnchor | null;
    // A writer's on a desktop or a tablet; a viewer and a phone read the notes.
    onOpen?: (pos: number, at: { left: number; top: number }) => void;
};

// A note as the schema writes it, so 133 notes are not 133 editors. Its images resolve as the figure's node view's do.
const StaticNote = memo(function StaticNote({ node }: { node: PMNode }) {
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
    return <div ref={ref} className="eigen-prose" />;
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
                    <li key={index}>
                        <sup className="footnote-number">{index + 1}</sup>
                        {pos === open?.pos ? (
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
                                <StaticNote node={node} />
                            </div>
                        )}
                    </li>
                ))}
            </ol>
        </section>
    );
}
