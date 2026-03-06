import {useState} from 'react';
import {Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle} from '@workspace/ui/components/dialog';
import {Button} from '@workspace/ui/components/button';
import {Input} from '@workspace/ui/components/input';
import {Label} from '@workspace/ui/components/label';
import {Textarea} from '@workspace/ui/components/textarea';
import {Select, SelectContent, SelectItem, SelectTrigger, SelectValue} from '@workspace/ui/components/select';
import {DEFAULT_TEXT_OBJECT} from './types';

type AddTextDialogProps = {
    isOpen: boolean;
    onClose: () => void;
    onAdd: (obj: typeof DEFAULT_TEXT_OBJECT & {text: string}) => void;
}

export function AddTextDialog({isOpen, onClose, onAdd}: AddTextDialogProps) {
    const [text, setText] = useState('');
    const [fontSize, setFontSize] = useState(48);
    const [fontWeight, setFontWeight] = useState<'normal' | 'bold'>('normal');
    const [textAlign, setTextAlign] = useState<'left' | 'center' | 'right'>('center');
    const [color, setColor] = useState('#000000');

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (!text.trim()) return;
        onAdd({
            ...DEFAULT_TEXT_OBJECT,
            text: text.trim(),
            fontSize,
            fontWeight,
            textAlign,
            color,
        });
        setText('');
        setFontSize(48);
        setFontWeight('normal');
        setTextAlign('center');
        setColor('#000000');
        onClose();
    };

    return (
        <Dialog open={isOpen} onOpenChange={onClose}>
            <DialogContent className="sm:max-w-[425px]">
                <form onSubmit={handleSubmit}>
                    <DialogHeader>
                        <DialogTitle>Add Text</DialogTitle>
                    </DialogHeader>
                    <div className="grid gap-4 py-4">
                        <div className="grid gap-2">
                            <Label htmlFor="text">Text</Label>
                            <Textarea
                                id="text"
                                value={text}
                                onChange={(e) => setText(e.target.value)}
                                placeholder="Enter text"
                                rows={3}
                                autoFocus
                                required
                            />
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                            <div className="grid gap-2">
                                <Label htmlFor="fontSize">Font Size</Label>
                                <Input
                                    id="fontSize"
                                    type="number"
                                    value={fontSize}
                                    onChange={(e) => setFontSize(Number(e.target.value))}
                                    min={12}
                                    max={200}
                                />
                            </div>
                            <div className="grid gap-2">
                                <Label>Weight</Label>
                                <Select value={fontWeight} onValueChange={(v) => setFontWeight(v as 'normal' | 'bold')}>
                                    <SelectTrigger><SelectValue/></SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="normal">Normal</SelectItem>
                                        <SelectItem value="bold">Bold</SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                            <div className="grid gap-2">
                                <Label>Align</Label>
                                <Select value={textAlign} onValueChange={(v) => setTextAlign(v as 'left' | 'center' | 'right')}>
                                    <SelectTrigger><SelectValue/></SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="left">Left</SelectItem>
                                        <SelectItem value="center">Center</SelectItem>
                                        <SelectItem value="right">Right</SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>
                            <div className="grid gap-2">
                                <Label htmlFor="color">Color</Label>
                                <Input
                                    id="color"
                                    type="color"
                                    value={color}
                                    onChange={(e) => setColor(e.target.value)}
                                    className="h-9 p-1"
                                />
                            </div>
                        </div>
                    </div>
                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
                        <Button type="submit" disabled={!text.trim()}>Add Text</Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
