import { Plugin, PluginKey } from '@tiptap/pm/state';
import { CommentMarkSchema } from '@workspace/lib/docs/eigendoc';

export type CommentMarkOptions = {
    onCommentClick?: (chatName: string) => void;
};

export const CommentMark = CommentMarkSchema.extend<CommentMarkOptions>({
    addOptions() {
        return { onCommentClick: undefined };
    },

    addProseMirrorPlugins() {
        const onCommentClick = this.options.onCommentClick;
        if (!onCommentClick) return [];

        return [
            new Plugin({
                key: new PluginKey('commentClick'),
                props: {
                    handleClick: (_view, _pos, event) => {
                        const target = event.target as HTMLElement;
                        const commentEl = target.closest('.comment-highlight');
                        if (commentEl) {
                            const chatName = commentEl.getAttribute('data-chat-name');
                            if (chatName) {
                                onCommentClick(chatName);
                                return true;
                            }
                        }
                        return false;
                    },
                },
            }),
        ];
    },
});
