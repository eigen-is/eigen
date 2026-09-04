import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { eigenDocEditorValidateSearch } from '@workspace/ui/components/drive';
import { EigenDocEditorRoute } from '@workspace/ui/components/layout/app/eigen-doc-editor-route';
import { useLatchedDocSearchTerm } from '@workspace/ui/hooks/use-eigen-doc-editor-route';
import { useCallback } from 'react';
import { StickiesBoard } from '../components/stickies/board';

export const Route = createFileRoute('/_auth/board/$ownerId/$mountId/$pathId')({
    component: StickiesRoute,
    validateSearch: eigenDocEditorValidateSearch,
});

function StickiesRoute() {
    const { ownerId, mountId, pathId } = Route.useParams();
    const { chat, card, q } = Route.useSearch();
    const navigate = useNavigate();
    const initialSearchTerm = useLatchedDocSearchTerm(q);
    const handleClearChat = useCallback(() => {
        navigate({
            to: Route.fullPath,
            params: { ownerId, mountId, pathId },
            search: (prev) => ({ ...prev, chat: undefined }),
            replace: true,
        });
    }, [navigate, ownerId, mountId, pathId]);

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
                    initialChatName={chat}
                    onClearInitialChat={handleClearChat}
                    initialSearchTerm={initialSearchTerm}
                    initialCardId={card}
                    onClearInitialCard={handleClearCard}
                />
            )}
        </EigenDocEditorRoute>
    );
}
