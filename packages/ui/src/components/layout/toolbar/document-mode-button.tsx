// The read-only marker an open document shows in its share cluster where the Share button would be, for someone who
// may not write. It names no role: a reader through a link, with or without a login, has none.

import { Eye } from 'lucide-react';
import { TooltipButton } from './tooltip-button';

export const DocumentModeButton = () => <TooltipButton icon={Eye} tooltipText="You can view this document" />;
