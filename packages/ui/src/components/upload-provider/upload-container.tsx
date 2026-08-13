import { Card, CardContent } from '@workspace/ui/components/card';
import { Progress } from '@workspace/ui/components/progress';
import { cn } from '@workspace/ui/lib/utils';
import { X } from 'lucide-react';
import type { UploadItem } from './upload-provider';

export function UploadContainer({ uploads, onRemove }: { uploads: UploadItem[]; onRemove: (id: string) => void }) {
    if (uploads.length === 0) return null;

    return (
        <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-md w-full transition-all duration-300 ease-in-out">
            {uploads.map((upload) => (
                <Card
                    key={upload.id}
                    className={cn(
                        'overflow-hidden transition-all duration-300 ease-in-out',
                        'animate-in slide-in-from-bottom-5',
                    )}
                >
                    <CardContent className="p-3">
                        <div className="flex justify-between items-center mb-2">
                            <p className="text-sm font-medium truncate mr-2">Uploading {upload.filename}</p>
                            {/* Only show cancel button if cancelFn exists */}
                            {upload.cancelFn && (
                                <button
                                    onClick={() => onRemove(upload.id)}
                                    className="text-muted-foreground hover:text-foreground rounded-full p-1"
                                >
                                    <X className="h-4 w-4" />
                                    <span className="sr-only">Cancel</span>
                                </button>
                            )}
                        </div>
                        <Progress
                            value={upload.progress}
                            className={cn(upload.status === 'error' && 'bg-destructive/20')}
                        />
                        {upload.status === 'error' && (
                            <p className="text-xs text-destructive mt-1">{upload.errorMessage ?? 'Upload failed'}</p>
                        )}
                    </CardContent>
                </Card>
            ))}
        </div>
    );
}
