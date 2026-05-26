import { getFileIconComponent } from '@workspace/lib/file-presentation';
import type { File } from 'lucide-react';
import type React from 'react';

// JSX-rendering wrapper around the lib-side icon registry. Lives here (not in
// lib) because lib stays DOM-free — getFileIcon returns React elements, while
// the underlying getFileIconComponent / getFilePresentation are pure data and
// are reachable from FE-only lib code (e.g. the command palette).
export { type FilePresentation, getFileIconComponent, getFilePresentation } from '@workspace/lib/file-presentation';

type FileIconProps = React.ComponentProps<typeof File>;

export function getFileIcon(mimeType: string, type: string, props?: FileIconProps) {
    const Icon = getFileIconComponent(mimeType, type);
    return <Icon {...props} />;
}
