import {useEffect} from "react";

export type FilePreviewProps = {
    url: string;
    mimeType: string;
    onClose: () => void;
    open: boolean;
    aspectRatio?: number;
}

export function FilePreview({url, mimeType, onClose, open, aspectRatio}: FilePreviewProps) {
    if (!open) return null;

    useEffect(() => {
        const handleEscapeKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                onClose();
            }
        };

        document.addEventListener("keydown", handleEscapeKey);

        return () => {
            document.removeEventListener("keydown", handleEscapeKey);
        };
    }, [onClose]);

    return (
        <div
            className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center animate-in fade-in"
            onClick={onClose}
            style={{cursor: "zoom-out"}}
        >
            <div
                className="max-w-[90vw] max-h-[90vh] bg-white rounded-lg shadow-lg flex items-center justify-center p-4 animate-in zoom-in-95"
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
                    <iframe src={url} className="w-[80vw] h-[80vh] rounded bg-white"/>
                )}
            </div>
        </div>
    );
}
