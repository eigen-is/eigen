import { useCallback, useState } from 'react';

type DocumentPanel = 'comments' | 'activity';

// The eigendoc editors' comments/activity panels are mutually exclusive, so one slot holds that
// invariant instead of a boolean pair every host has to keep in sync by hand. Host-owned like
// useCommentFilter: the toolbar toggles, the desktop side panel and the mobile Column all read it.
// isMobile stays with the host — lib must not reach into the layout context.
export function useDocumentPanels(): {
    panel: DocumentPanel | null;
    commentPanelOpen: boolean;
    activityPanelOpen: boolean;
    toggleComments: () => void;
    toggleActivity: () => void;
    openComments: () => void;
    closePanels: () => void;
} {
    const [panel, setPanel] = useState<DocumentPanel | null>(null);

    const toggleComments = useCallback(() => setPanel((p) => (p === 'comments' ? null : 'comments')), []);
    const toggleActivity = useCallback(() => setPanel((p) => (p === 'activity' ? null : 'activity')), []);
    const openComments = useCallback(() => setPanel('comments'), []);
    const closePanels = useCallback(() => setPanel(null), []);

    return {
        panel,
        commentPanelOpen: panel === 'comments',
        activityPanelOpen: panel === 'activity',
        toggleComments,
        toggleActivity,
        openComments,
        closePanels,
    };
}
