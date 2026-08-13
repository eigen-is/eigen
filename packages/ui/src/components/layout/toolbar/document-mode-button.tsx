import { Eye } from 'lucide-react';
import { TooltipButton } from './tooltip-button';

// Read-only marker in the share cluster's Share slot — the Share button replaces it when canWrite.
export const DocumentModeButton = () => (
    <TooltipButton icon={Eye} tooltipText="You can only read this document because you're set to Viewer" />
);
