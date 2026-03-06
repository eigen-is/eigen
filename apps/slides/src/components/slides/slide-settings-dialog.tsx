import {useState} from 'react';
import {Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle} from '@workspace/ui/components/dialog';
import {Button} from '@workspace/ui/components/button';
import {Label} from '@workspace/ui/components/label';
import {SLIDE_BACKGROUNDS} from './types';
import {cn} from '@workspace/ui/lib/utils';
import {Check} from 'lucide-react';

type SlideSettingsDialogProps = {
    isOpen: boolean;
    onClose: () => void;
    slideId: string | null;
    currentBackground: string;
    onUpdateBackground: (slideId: string, color: string) => void;
    onDeleteSlide: (slideId: string) => void;
    onDuplicateSlide: (slideId: string) => void;
    slideCount: number;
}

export function SlideSettingsDialog({isOpen, onClose, slideId, currentBackground, onUpdateBackground, onDeleteSlide, onDuplicateSlide, slideCount}: SlideSettingsDialogProps) {
    const [bg, setBg] = useState(currentBackground);

    if (!slideId) return null;

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        onUpdateBackground(slideId, bg);
        onClose();
    };

    return (
        <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="sm:max-w-sm">
                <DialogHeader>
                    <DialogTitle>Slide Settings</DialogTitle>
                </DialogHeader>
                <form onSubmit={handleSubmit}>
                    <div className="grid gap-4 py-4">
                        <div className="grid gap-2">
                            <Label>Background</Label>
                            <div className="flex gap-2 flex-wrap">
                                {SLIDE_BACKGROUNDS.map(({label, value}) => (
                                    <button
                                        key={value}
                                        type="button"
                                        title={label}
                                        onClick={() => setBg(value)}
                                        className={cn(
                                            'w-8 h-8 rounded border-2 flex items-center justify-center',
                                            bg === value ? 'border-blue-500' : 'border-border',
                                        )}
                                        style={{backgroundColor: value}}
                                    >
                                        {bg === value && <Check className={cn('w-4 h-4', value === '#000000' || value === '#1e293b' || value === '#1e3a5f' || value === '#7f1d1d' ? 'text-white' : 'text-black')}/>}
                                    </button>
                                ))}
                            </div>
                        </div>
                    </div>
                    <DialogFooter className="sm:justify-between">
                        <div className="flex gap-2">
                            <Button type="button" variant="outline" onClick={() => { onDuplicateSlide(slideId); onClose(); }}>
                                Duplicate
                            </Button>
                            {slideCount > 1 && (
                                <Button type="button" variant="destructive" onClick={() => { onDeleteSlide(slideId); onClose(); }}>
                                    Delete
                                </Button>
                            )}
                        </div>
                        <div className="flex gap-2">
                            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
                            <Button type="submit">Save</Button>
                        </div>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
