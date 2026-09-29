import type { Editor } from '@tiptap/react';
import type { ActiveComments } from '@workspace/lib/types/comments';
import { useEffect, useState } from 'react';
import { commentAnchorText, nodeCommentCardId } from '../extensions/comment-mark';

const EMPTY_ACTIVE: ActiveComments = { ids: new Set(), anchorTexts: new Map() };

// Active comment cards + their anchor text, derived from the editor's comment anchors (the `comment`
// mark on text, `commentCardId` on a figure). Doc-model specific (walks the ProseMirror doc), so it
// stays a per-app hook — the slides/sheets siblings walk their own models. Debounced 200ms and
// refreshed on every editor update.
export function useActiveComments(editor: Editor | null): ActiveComments {
    const [result, setResult] = useState<ActiveComments>(EMPTY_ACTIVE);

    useEffect(() => {
        if (!editor) return;
        let timer: ReturnType<typeof setTimeout>;

        const update = () => {
            clearTimeout(timer);
            timer = setTimeout(() => {
                const ids = new Set<string>();
                const texts = new Map<string, string>();

                editor.state.doc.descendants((node, pos) => {
                    const cardId = nodeCommentCardId(node);
                    if (!cardId) return;
                    ids.add(cardId);
                    if (!texts.has(cardId)) {
                        texts.set(cardId, commentAnchorText(editor.state.doc, pos, pos + node.nodeSize));
                    }
                });

                setResult({ ids, anchorTexts: texts });
            }, 200);
        };

        update();
        editor.on('update', update);
        return () => {
            editor.off('update', update);
            clearTimeout(timer);
        };
    }, [editor]);

    return result;
}
