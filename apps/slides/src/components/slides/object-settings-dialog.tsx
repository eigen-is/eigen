import {useState} from 'react';
import {Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle} from '@workspace/ui/components/dialog';
import {Button} from '@workspace/ui/components/button';
import {Input} from '@workspace/ui/components/input';
import {Label} from '@workspace/ui/components/label';
import {Textarea} from '@workspace/ui/components/textarea';
import {Select, SelectContent, SelectItem, SelectTrigger, SelectValue} from '@workspace/ui/components/select';
import {SlideObject} from './types';

type ObjectSettingsDialogProps = {
    isOpen: boolean;
    onClose: () => void;
    object: SlideObject | null;
    onUpdate: (objId: string, updates: Partial<SlideObject>) => void;
    onDelete: (objId: string) => void;
}

export function ObjectSettingsDialog({isOpen, onClose, object, onUpdate, onDelete}: ObjectSettingsDialogProps) {
    if (!object) return null;

    return (
        <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>{object.type === 'text' ? 'Text' : 'Image'} Settings</DialogTitle>
                </DialogHeader>
                {object.type === 'text' ? (
                    <TextSettings object={object} onUpdate={onUpdate} onClose={onClose} onDelete={onDelete}/>
                ) : (
                    <ImageSettings object={object} onUpdate={onUpdate} onClose={onClose} onDelete={onDelete}/>
                )}
            </DialogContent>
        </Dialog>
    );
}

function TextSettings({object, onUpdate, onClose, onDelete}: {
    object: SlideObject & {type: 'text'};
    onUpdate: (objId: string, updates: Partial<SlideObject>) => void;
    onClose: () => void;
    onDelete: (objId: string) => void;
}) {
    const [text, setText] = useState(object.text);
    const [fontSize, setFontSize] = useState(object.fontSize);
    const [fontWeight, setFontWeight] = useState(object.fontWeight);
    const [fontStyle, setFontStyle] = useState(object.fontStyle);
    const [textAlign, setTextAlign] = useState(object.textAlign);
    const [color, setColor] = useState(object.color);

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        onUpdate(object.id, {text, fontSize, fontWeight, fontStyle, textAlign, color});
        onClose();
    };

    return (
        <form onSubmit={handleSubmit}>
            <div className="grid gap-4 py-4">
                <div className="grid gap-2">
                    <Label htmlFor="text">Text</Label>
                    <Textarea id="text" value={text} onChange={(e) => setText(e.target.value)} rows={3}/>
                </div>
                <div className="grid grid-cols-2 gap-4">
                    <div className="grid gap-2">
                        <Label htmlFor="fontSize">Font Size</Label>
                        <Input id="fontSize" type="number" value={fontSize} onChange={(e) => setFontSize(Number(e.target.value))} min={12} max={200}/>
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
                <div className="grid grid-cols-3 gap-4">
                    <div className="grid gap-2">
                        <Label>Style</Label>
                        <Select value={fontStyle} onValueChange={(v) => setFontStyle(v as 'normal' | 'italic')}>
                            <SelectTrigger><SelectValue/></SelectTrigger>
                            <SelectContent>
                                <SelectItem value="normal">Normal</SelectItem>
                                <SelectItem value="italic">Italic</SelectItem>
                            </SelectContent>
                        </Select>
                    </div>
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
                        <Input id="color" type="color" value={color} onChange={(e) => setColor(e.target.value)} className="h-9 p-1"/>
                    </div>
                </div>
            </div>
            <DialogFooter className="sm:justify-between">
                <Button type="button" variant="destructive" onClick={() => { onDelete(object.id); onClose(); }}>Delete</Button>
                <div className="flex gap-2">
                    <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
                    <Button type="submit">Save</Button>
                </div>
            </DialogFooter>
        </form>
    );
}

function ImageSettings({object, onUpdate, onClose, onDelete}: {
    object: SlideObject & {type: 'image'};
    onUpdate: (objId: string, updates: Partial<SlideObject>) => void;
    onClose: () => void;
    onDelete: (objId: string) => void;
}) {
    const [objectFit, setObjectFit] = useState(object.objectFit);

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        onUpdate(object.id, {objectFit});
        onClose();
    };

    return (
        <form onSubmit={handleSubmit}>
            <div className="grid gap-4 py-4">
                <div className="grid gap-2">
                    <Label>Preview</Label>
                    <div className="border rounded overflow-hidden">
                        <img src={object.src} alt="" className="max-h-32 mx-auto object-contain"/>
                    </div>
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
            <DialogFooter className="sm:justify-between">
                <Button type="button" variant="destructive" onClick={() => { onDelete(object.id); onClose(); }}>Delete</Button>
                <div className="flex gap-2">
                    <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
                    <Button type="submit">Save</Button>
                </div>
            </DialogFooter>
        </form>
    );
}
