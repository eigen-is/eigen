// The read-only marker an open document shows in its share cluster where the Share button would be, for someone who
// may not write. A viewer is told why, being set to Viewer; a visitor with a public link has no role, so is told only
// that they can view.

import { useAuth } from '@workspace/lib/auth';
import { Eye } from 'lucide-react';
import { TooltipButton } from './tooltip-button';

export const DocumentModeButton = () => {
    const { user } = useAuth();
    return (
        <TooltipButton
            icon={Eye}
            tooltipText={
                user ? "You can only read this document because you're set to Viewer" : 'You can view this document'
            }
        />
    );
};
