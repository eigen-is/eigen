// The notes under the page, as Google's page-less document collects them at its end: each numbered, drawn as static
// HTML, and the open one as the note's live editor in its place. A press on a note opens it.

import type { Editor } from '@tiptap/react';
import { EditorContent, useEditorState } from '@tiptap/react';
import { cn } from '@workspace/ui/lib/utils';
import { footnotesInDoc } from './extensions/footnote';
import { StaticStory } from './extensions/static-story';
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
