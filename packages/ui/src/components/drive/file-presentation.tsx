// Draws a file's icon as a React element. Which icon and label a file gets is pure data in the lib package, which
// stays free of JSX, so lib code such as the command palette reads it too. This wrapper renders that icon for the
// UI, and passes getFileIconComponent and getFilePresentation on, so a component imports all three from here.

import { getFileIconComponent } from '@workspace/lib/file-presentation';
import type { File } from 'lucide-react';
import type React from 'react';

export { getFileIconComponent, getFilePresentation } from '@workspace/lib/file-presentation';

type FileIconProps = React.ComponentProps<typeof File>;

export function getFileIcon(mimeType: string, type: string, name: string, props?: FileIconProps) {
    const Icon = getFileIconComponent(mimeType, type, name);
    return <Icon {...props} />;
}
