import {useHotkey} from "@tanstack/react-hotkeys";

interface FilePreviewProps {
    url: string;
    mimeType: string;
    onClose: () => void;
    open: boolean;
    aspectRatio?: string;
}

export function FilePreview({url, mimeType, onClose, open, aspectRatio}: FilePreviewProps) {
    useHotkey('Escape', () => onClose(), {enabled: open});

    if (!open) return null;

    return (
        <div
            className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center animate-in fade-in"
            onClick={onClose}
            style={{cursor: "zoom-out"}}
        >
            <div
                className="max-w-[90vw] max-h-[90vh] bg-background rounded-lg shadow-lg flex items-center justify-center p-4 animate-in zoom-in-95"
                onClick={(e) => e.stopPropagation()}
            >
                {mimeType.startsWith("image/") && (
                    <img
                        src={url}
                        alt="Preview"
                        className="max-w-full max-h-[80vh] rounded"
                        style={aspectRatio ? {aspectRatio} : undefined}
                    />
                )}
                {mimeType.startsWith("video/") && (
                    <video
                        src={url}
                        controls
                        className="max-w-full max-h-[80vh] rounded"
                        style={aspectRatio ? {aspectRatio} : undefined}
                    />
                )}
                {mimeType === "application/pdf" && (
                    <iframe src={url} className="w-[80vw] h-[80vh] rounded bg-background"/>
                )}
            </div>
        </div>
    );
}
