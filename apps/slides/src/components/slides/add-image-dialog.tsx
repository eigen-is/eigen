import {useRef, useState} from 'react';
import {Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle} from '@workspace/ui/components/dialog';
import {Button} from '@workspace/ui/components/button';
import {Label} from '@workspace/ui/components/label';
import {Select, SelectContent, SelectItem, SelectTrigger, SelectValue} from '@workspace/ui/components/select';
import {DEFAULT_IMAGE_OBJECT} from './types';
import {ImagePlus} from 'lucide-react';

type AddImageDialogProps = {
    isOpen: boolean;
    onClose: () => void;
    onAdd: (obj: typeof DEFAULT_IMAGE_OBJECT & {src: string}) => void;
    onUpload: (file: File) => Promise<string | null>;
}

export function AddImageDialog({isOpen, onClose, onAdd, onUpload}: AddImageDialogProps) {
    const [objectFit, setObjectFit] = useState<'contain' | 'cover' | 'fill'>('contain');
    const [isUploading, setIsUploading] = useState(false);
    const [previewUrl, setPreviewUrl] = useState<string | null>(null);
    const [selectedFile, setSelectedFile] = useState<File | null>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file || !file.type.startsWith('image/')) return;
        setSelectedFile(file);
        setPreviewUrl(URL.createObjectURL(file));
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!selectedFile) return;
        setIsUploading(true);
        try {
            const src = await onUpload(selectedFile);
            if (src) {
                onAdd({...DEFAULT_IMAGE_OBJECT, objectFit, src});
            }
        } finally {
            setIsUploading(false);
            reset();
            onClose();
        }
    };

    const reset = () => {
        setSelectedFile(null);
        setPreviewUrl(null);
        setObjectFit('contain');
    };

    return (
        <Dialog open={isOpen} onOpenChange={(open) => { if (!open) { reset(); onClose(); } }}>
            <DialogContent className="sm:max-w-[425px]">
                <form onSubmit={handleSubmit}>
                    <DialogHeader>
                        <DialogTitle>Add Image</DialogTitle>
                    </DialogHeader>
                    <div className="grid gap-4 py-4">
                        <div className="grid gap-2">
                            <Label>Image</Label>
                            <input
                                ref={inputRef}
                                type="file"
                                accept="image/*"
                                onChange={handleFileChange}
                                className="hidden"
                            />
                            {previewUrl ? (
                                <button
                                    type="button"
                                    onClick={() => inputRef.current?.click()}
                                    className="border rounded-md overflow-hidden"
                                >
                                    <img src={previewUrl} alt="Preview" className="max-h-40 mx-auto object-contain"/>
                                </button>
                            ) : (
                                <Button
                                    type="button"
                                    variant="outline"
                                    className="h-32 w-full border-dashed"
                                    onClick={() => inputRef.current?.click()}
                                >
                                    <div className="flex flex-col items-center gap-2 text-muted-foreground">
                                        <ImagePlus className="h-8 w-8"/>
                                        <span className="text-sm">Choose an image</span>
                                    </div>
                                </Button>
                            )}
                        </div>
                        <div className="grid gap-2">
                            <Label>Fit</Label>
                            <Select value={objectFit} onValueChange={(v) => setObjectFit(v as 'contain' | 'cover' | 'fill')}>
                                <SelectTrigger><SelectValue/></SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="contain">Contain</SelectItem>
                                    <SelectItem value="cover">Cover</SelectItem>
                                    <SelectItem value="fill">Fill</SelectItem>
                                </SelectContent>
                            </Select>
                        </div>
                    </div>
                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={() => { reset(); onClose(); }}>Cancel</Button>
                        <Button type="submit" disabled={!selectedFile || isUploading}>
                            {isUploading ? 'Uploading...' : 'Add Image'}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
