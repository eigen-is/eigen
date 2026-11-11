// The comments the body uses, read from the editor's comment anchors: the `comment` mark on text and `commentCardId`
// on a node such as a figure or an equation. The pane lists them and the comment lifecycle reads them as the active
// set. The walk runs 200 ms after the editor's last change, so `ready` stays false until the first walk ran, and until
// then no card reads deleted.

import type { Editor } from '@tiptap/react';
import type { ActiveComments } from '@workspace/lib/types/comments';
import { useEffect, useState } from 'react';
import { nodeCommentCardId } from '../extensions/comment-mark';

type BodyComments = ActiveComments & { ready: boolean };

const NOT_READY: BodyComments = { ids: new Set(), ready: false };

export function useActiveComments(editor: Editor): BodyComments {
    const [result, setResult] = useState<BodyComments>(NOT_READY);

    useEffect(() => {
        let timer: ReturnType<typeof setTimeout>;

        const update = () => {
            clearTimeout(timer);
            timer = setTimeout(() => {
                const ids = new Set<string>();
                editor.state.doc.descendants((node) => {
                    const cardId = nodeCommentCardId(node);
                    if (cardId) ids.add(cardId);
                });
                setResult({ ids, ready: true });
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
