import { useMatch, useNavigate } from '@tanstack/react-router';
import { SidebarPrimaryButton } from '@workspace/ui/components/layout/sidebar/sidebar-primary-button';
import { MailPlus } from 'lucide-react';

// Import route to get correct path information
import { Route as FilterRoute } from '../../routes/_auth.$filterType.$filterId';

type EmailComposeButtonProps = {
    condensed: boolean;
};

export function EmailComposeButton({ condensed }: EmailComposeButtonProps) {
    const match = useMatch({
        from: '/_auth/$filterType/$filterId',
        shouldThrow: false,
    });

    const filterType = match?.params?.filterType ?? 'box';
    const filterId = match?.params?.filterId ?? 'inbox';

    const navigate = useNavigate();

    // Fresh composeSessionKey remounts any composer that happened to be open (e.g. the user
    // was in the middle of a reply) — matches the session-key contract in use-mail-actions.ts.
    const handleComposeClick = async () => {
        navigate({
            to: FilterRoute.fullPath,
            params: { filterType, filterId },
            search: { mode: 'compose' },
            state: { composeSessionKey: crypto.randomUUID() },
        });
    };

    return <SidebarPrimaryButton icon={MailPlus} label="Compose" condensed={condensed} onClick={handleComposeClick} />;
}
