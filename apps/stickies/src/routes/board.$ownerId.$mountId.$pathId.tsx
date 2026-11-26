// The route of one open stickies board. It renders the board inside the shared editor route, which loads the document
// and shows its status, and threads in the comment or card a ?chat= or ?card= link names, the find bar's ?q=, and
// the way to drop a link from the URL once it names nothing. It sits outside the login guard, so a public link opens
// it without a login: the link guard sends a visitor of a private board to log in.

import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { eigenDocEditorValidateSearch } from '@workspace/ui/components/drive';
import { EigenDocEditorRoute } from '@workspace/ui/components/layout/app';
import { guardLinkRoute } from '@workspace/ui/components/layout/pages';
import { useLatchedDocSearchTerm } from '@workspace/ui/hooks/use-latched-doc-search-term';
import { useCallback } from 'react';
import { StickiesBoard } from '../components/stickies/board';

export const Route = createFileRoute('/board/$ownerId/$mountId/$pathId')({
    beforeLoad: ({ context, location, params }) => guardLinkRoute(context, location, params),
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
