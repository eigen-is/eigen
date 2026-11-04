// The comment cards a doc's JSON anchors, for a reader without an editor, such as the server's read of what a
// document still uses. A card sits on text as the `comment` mark, and on a node the Yjs binding keeps no mark on, such
// as an image, a text box or an equation, as an attribute. The editor asks the same of its own nodes.

import { isRecord } from '../../core/guards';
import { COMMENT_CARD_ATTRIBUTE, COMMENT_MARK_CARD_ATTRIBUTE, CommentMarkSchema } from './nodes/comment-mark';

// It walks the whole tree, so it finds the cards of any fragment it is given, a band's included.
export function commentCardIdsIn(tree: unknown): Set<string> {
    const ids = new Set<string>();
    const stack = [tree];
    while (stack.length > 0) {
        const value = stack.pop();
        if (!value || typeof value !== 'object') continue;
        const markCardId =
            isRecord(value) && value['type'] === CommentMarkSchema.name && isRecord(value['attrs'])
                ? value['attrs'][COMMENT_MARK_CARD_ATTRIBUTE]
                : undefined;
        if (typeof markCardId === 'string' && markCardId) ids.add(markCardId);
        for (const [key, child] of Object.entries(value)) {
            if (key === COMMENT_CARD_ATTRIBUTE && typeof child === 'string' && child) ids.add(child);
            else stack.push(child);
        }
    }
    return ids;
}
