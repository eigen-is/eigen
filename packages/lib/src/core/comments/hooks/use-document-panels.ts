// Which side panel a document shows, comments or activity. The two can't be open at once, so one slot holds that
// rule instead of two booleans every host keeps in sync. The host owns it, as it owns useCommentFilter, and its
// toolbar, side panel and pane read it.

import { useCallback, useState } from 'react';
import type { DocumentPanel } from '../../../types/comments';

export function useDocumentPanels(isMobile: boolean): {
    panel: DocumentPanel | null;
    commentPanelOpen: boolean;
    activityPanelOpen: boolean;
    mobilePanelOpen: boolean;
    toggleComments: () => void;
    toggleActivity: () => void;
    openComments: () => void;
    closePanels: () => void;
    onSearchOpenChange: (open: boolean) => void;
} {
    const [panel, setPanel] = useState<DocumentPanel | null>(null);

    const toggleComments = useCallback(() => setPanel((p) => (p === 'comments' ? null : 'comments')), []);
    const toggleActivity = useCallback(() => setPanel((p) => (p === 'activity' ? null : 'activity')), []);
    const openComments = useCallback(() => setPanel('comments'), []);
    const closePanels = useCallback(() => setPanel(null), []);

    // The find bar sits in the editor, which the pane covers on mobile. Opening search closes the pane, which is one
    // tap away again.
    const onSearchOpenChange = useCallback(
        (open: boolean) => {
            if (open && isMobile) setPanel(null);
        },
        [isMobile],
    );

    return {
        panel,
        commentPanelOpen: panel === 'comments',
        activityPanelOpen: panel === 'activity',
        // Below the breakpoint the side panel has no room; mobile hosts the same panels in a Column.
        mobilePanelOpen: isMobile && panel !== null,
        toggleComments,
        toggleActivity,
        openComments,
        closePanels,
        onSearchOpenChange,
    };
}
