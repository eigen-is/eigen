import {useEffect} from 'react';

interface MediaPreviewProps {
    src: string;
    type: 'image' | 'video';
    caption?: string;
    onClose: () => void;
}

export function MediaPreview({src, type, caption, onClose}: MediaPreviewProps) {
    useEffect(() => {
        const handleEscapeKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                onClose();
            }
        };

        document.addEventListener('keydown', handleEscapeKey);
        return () => {
            document.removeEventListener('keydown', handleEscapeKey);
        };
    }, [onClose]);

    return (
        <div
            className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center animate-in fade-in"
            onClick={onClose}
            style={{cursor: 'zoom-out'}}
        >
            <div
                className="max-w-[90vw] max-h-[90vh] bg-white rounded-lg shadow-lg flex flex-col items-center justify-center p-4 animate-in zoom-in-95"
                onClick={(e) => e.stopPropagation()}
            >
                {type === 'image' && (
                    <img src={src} alt={caption || 'Preview'} className="max-w-full max-h-[80vh] rounded"/>
                )}
                {type === 'video' && (
                    <video src={src} controls autoPlay={true} className="max-w-full max-h-[80vh] rounded"/>
                )}
                {caption && (
                    <p className="mt-4 text-sm text-gray-600 text-center max-w-2xl">{caption}</p>
                )}
            </div>
        </div>
    );
}
