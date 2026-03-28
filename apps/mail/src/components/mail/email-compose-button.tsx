import {useMatch, useNavigate} from '@tanstack/react-router';
import {Button} from '@workspace/ui/components/button';
import {MailPlus} from 'lucide-react';

// Import route to get correct path information
import {Route as FilterRoute} from '../../routes/_auth.$filterType.$filterId';

type EmailComposeButtonProps = {
    condensed: boolean;
};

export function EmailComposeButton({condensed}: EmailComposeButtonProps) {
    const match = useMatch({
        from: '/_auth/$filterType/$filterId',
        shouldThrow: false,
    });

    const filterType = match?.params?.filterType ?? 'box';
    const filterId = match?.params?.filterId ?? 'inbox';

    const navigate = useNavigate();

    const handleComposeClick = async () => {
        navigate({
            to: FilterRoute.fullPath,
            params: {filterType, filterId},
            search: {mode: 'compose'},
        });
    };

    return (
        <Button
            variant="default"
            size={condensed ? 'icon' : 'default'}
            className={`${condensed ? 'w-10 p-0' : 'w-full justify-start gap-3'}`}
            onClick={handleComposeClick}
        >
            <MailPlus className="h-4 w-4"/>
            {!condensed && <span>Compose</span>}
        </Button>
    );
}
