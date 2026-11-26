// The Stickies board route: one board the URL names, opened through EigenDocEditorRoute. Its search names the open
// activity column (?panel=activity), the open card thread (?chat=), a copied card link (?card=), which it drops once
// used, and a find-bar landing (?q=).

import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { eigenDocEditorValidateSearch } from '@workspace/ui/components/drive';
import { EigenDocEditorRoute } from '@workspace/ui/components/layout/app';
import { useLatchedDocSearchTerm } from '@workspace/ui/hooks/use-latched-doc-search-term';
import { useCallback } from 'react';
import { StickiesBoard } from '../components/stickies/board';

export const Route = createFileRoute('/_auth/board/$ownerId/$mountId/$pathId')({
    component: StickiesRoute,
    validateSearch: eigenDocEditorValidateSearch,
});

function StickiesRoute() {
    const { ownerId, mountId, pathId } = Route.useParams();
    const { panel, chat, card, q } = Route.useSearch();
    const navigate = useNavigate();
    const initialSearchTerm = useLatchedDocSearchTerm(q);
    const handleClearCard = useCallback(() => {
        navigate({
            to: Route.fullPath,
            params: { ownerId, mountId, pathId },
            search: (prev) => ({ ...prev, card: undefined }),
            replace: true,
        });
    }, [navigate, ownerId, mountId, pathId]);

    return (
        <EigenDocEditorRoute ownerId={ownerId} mountId={mountId} pathId={pathId}>
            {(props) => (
                <StickiesBoard
                    ownerId={ownerId}
                    {...props}
                    panel={panel}
                    chat={chat}
                    initialSearchTerm={initialSearchTerm}
                    initialCardId={card}
                    onClearInitialCard={handleClearCard}
                />
            )}
        </EigenDocEditorRoute>
    );
}
