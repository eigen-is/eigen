import { EditorContent, useEditorState } from '@tiptap/react';
import type { BandRoot } from '@workspace/lib/docs/eigendoc';
import { bandHasContent } from '@workspace/lib/docs/eigendoc';
import { cn } from '@workspace/ui/lib/utils';
import type * as Y from 'yjs';
import { type DocMedia, useDocEditor } from './doc-editor';

// A header's distance from the paper's top edge and a footer's from its bottom one, Word's and Google's default.
const BAND_DISTANCE_MM = 12.7;

type PageBandProps = {
    media: DocMedia;
    yDoc: Y.Doc;
    field: BandRoot;
    // The header sits in the page's first grid row, the footer in its last.
    edge: 'top' | 'bottom';
    // The page's margin on that edge, in mm.
    margin: number;
    onOpen?: () => void;
};

// A band drawn read-only on the page, dimmed: the header in the top margin, the footer after the last block in the
// bottom one. The negative margin pulls the band into the page's padding and its min-height gives the room back, so a
// band taller than the room pushes the body, as Word does. A non-editable editor on the band's root, so a
// collaborator's edit shows as it lands and an image resolves as in the body; it sets no caret, or it would clear the
// one the band's own editor sets. A click on a link follows the link rather than opening the panel.
export function PageBand({ media, yDoc, field, edge, margin, onOpen }: PageBandProps) {
    const editor = useDocEditor({ media, yDoc, provider: null, editable: false, target: { field } });
    const hasContent = useEditorState({ editor, selector: ({ editor: e }) => bandHasContent(e.state.doc) });
    const pull = `calc(${BAND_DISTANCE_MM}mm - ${margin}mm)`;
    const room = `max(0mm, ${margin}mm - ${BAND_DISTANCE_MM}mm)`;
    return (
        <div
            data-page-band={field}
            hidden={!hasContent}
            className={cn(
                'opacity-50 print:hidden',
                edge === 'top' ? 'row-start-1' : 'row-start-3 flex flex-col justify-end',
                onOpen && 'cursor-pointer',
            )}
            style={edge === 'top' ? { marginTop: pull, minHeight: room } : { marginBottom: pull, minHeight: room }}
            onClick={(event) => {
                if (!(event.target instanceof Element && event.target.closest('a'))) onOpen?.();
            }}
        >
            <EditorContent editor={editor} />
        </div>
    );
}
