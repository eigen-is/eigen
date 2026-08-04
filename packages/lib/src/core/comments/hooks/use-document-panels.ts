import { useCallback, useState } from 'react';
import type { DocumentPanel } from '../../../types/comments';

// Comments and activity are mutually exclusive, so one slot holds that invariant instead of a boolean
// pair every host syncs by hand. Host-owned like useCommentFilter: toolbar, side panel and pane read it.
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

    // The find bar rides with the editor, which the pane hides — reveal it, the pane is one tap away.
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
