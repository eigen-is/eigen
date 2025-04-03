import {Button} from "@workspace/ui/components/button";
import {MailPlus} from "lucide-react";
import {useNavigate, useParams} from "@tanstack/react-router";

// Import route to get correct path information
import {Route as FilterRoute} from '../../routes/_auth.$filterType.$filterId';

interface EmailComposeButtonProps {
    condensed: boolean;
}

export function EmailComposeButton({condensed}: EmailComposeButtonProps) {
    // Get the current route parameters using useParams
    const {filterType, filterId} = useParams({
        from: '/_auth/$filterType/$filterId',
    });

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
            size={condensed ? "icon" : "default"}
            className={`${condensed ? 'w-10 p-0' : 'w-full justify-start gap-3'}`}
            onClick={handleComposeClick}
        >
            <MailPlus className="h-4 w-4"/>
            {!condensed && <span>Compose</span>}
        </Button>
    );
}
