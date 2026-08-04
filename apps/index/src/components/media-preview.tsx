import { useHotkey } from '@tanstack/react-hotkeys';
import { useFocusTrap } from '@workspace/ui/hooks/use-focus-trap';
import { useRef } from 'react';

type MediaPreviewProps = {
    src: string;
    type: 'image' | 'video';
    caption?: string;
    onClose: () => void;
};

export function MediaPreview({ src, type, caption, onClose }: MediaPreviewProps) {
    useHotkey('Escape', () => onClose());

    const overlayRef = useRef<HTMLDivElement>(null);
    useFocusTrap(overlayRef);

    return (
        <div
            ref={overlayRef}
            role="dialog"
            aria-modal="true"
            aria-label={caption || 'Media preview'}
            tabIndex={-1}
            className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center animate-in fade-in outline-none"
            onClick={onClose}
            style={{ cursor: 'zoom-out' }}
        >
            <div
                className="max-w-[90vw] max-h-[90vh] bg-background rounded-lg shadow-lg flex flex-col items-center justify-center p-4 animate-in zoom-in-95"
                onClick={(e) => e.stopPropagation()}
            >
                {type === 'image' && (
                    <img src={src} alt={caption || 'Preview'} className="max-w-full max-h-[80vh] rounded" />
                )}
                {type === 'video' && (
                    <video src={src} controls autoPlay={true} className="max-w-full max-h-[80vh] rounded" />
                )}
                {caption && <p className="mt-4 text-sm text-muted-foreground text-center max-w-2xl">{caption}</p>}
            </div>
        </div>
    );
}
