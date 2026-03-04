import {useHotkey} from "@tanstack/react-hotkeys";

export type FilePreviewProps = {
    url: string;
    mimeType: string;
    onClose: () => void;
    open: boolean;
    aspectRatio?: number;
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
                className="max-w-[90vw] max-h-[90vh] bg-white rounded-lg shadow-lg flex items-center justify-center p-4 animate-in zoom-in-95"
                onClick={(e) => e.stopPropagation()} // Re-add this to prevent clicks inside from closing
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
                    <iframe src={url} className="w-[80vw] h-[80vh] rounded bg-white"/>
                )}
            </div>
        </div>
    );
}
