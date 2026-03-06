import {useCallback, useRef, useState} from 'react';
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
    const originalRef = useRef({text: object.text, fontSize: object.fontSize, fontWeight: object.fontWeight, fontStyle: object.fontStyle, textAlign: object.textAlign, color: object.color});
    const [text, setText] = useState(object.text);
    const [fontSize, setFontSize] = useState(object.fontSize);
    const [fontWeight, setFontWeight] = useState(object.fontWeight);
    const [fontStyle, setFontStyle] = useState(object.fontStyle);
    const [textAlign, setTextAlign] = useState(object.textAlign);
    const [color, setColor] = useState(object.color);

    const liveUpdate = useCallback((updates: Partial<SlideObject>) => {
        onUpdate(object.id, updates);
    }, [object.id, onUpdate]);

    const handleCancel = useCallback(() => {
        onUpdate(object.id, originalRef.current);
        onClose();
    }, [object.id, onUpdate, onClose]);

    return (
        <div className="grid gap-4 py-4">
            <div className="grid gap-2">
                <Label htmlFor="text">Text</Label>
                <Textarea id="text" value={text} onChange={(e) => { setText(e.target.value); liveUpdate({text: e.target.value}); }} rows={3}/>
            </div>
            <div className="grid grid-cols-2 gap-4">
                <div className="grid gap-2">
                    <Label htmlFor="fontSize">Font Size</Label>
                    <Input id="fontSize" type="number" value={fontSize} onChange={(e) => { const v = Number(e.target.value); setFontSize(v); liveUpdate({fontSize: v}); }} min={12} max={200}/>
                </div>
                <div className="grid gap-2">
                    <Label>Weight</Label>
                    <Select value={fontWeight} onValueChange={(v) => { const val = v as 'normal' | 'bold'; setFontWeight(val); liveUpdate({fontWeight: val}); }}>
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
                    <Select value={fontStyle} onValueChange={(v) => { const val = v as 'normal' | 'italic'; setFontStyle(val); liveUpdate({fontStyle: val}); }}>
                        <SelectTrigger><SelectValue/></SelectTrigger>
                        <SelectContent>
                            <SelectItem value="normal">Normal</SelectItem>
                            <SelectItem value="italic">Italic</SelectItem>
                        </SelectContent>
                    </Select>
                </div>
                <div className="grid gap-2">
                    <Label>Align</Label>
                    <Select value={textAlign} onValueChange={(v) => { const val = v as 'left' | 'center' | 'right'; setTextAlign(val); liveUpdate({textAlign: val}); }}>
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
                    <Input id="color" type="color" value={color} onChange={(e) => { setColor(e.target.value); liveUpdate({color: e.target.value}); }} className="h-9 p-1"/>
                </div>
            </div>
            <DialogFooter className="sm:justify-between">
                <Button type="button" variant="destructive" onClick={() => { onDelete(object.id); onClose(); }}>Delete</Button>
                <div className="flex gap-2">
                    <Button type="button" variant="outline" onClick={handleCancel}>Cancel</Button>
                    <Button type="button" onClick={onClose}>Done</Button>
                </div>
            </DialogFooter>
        </div>
    );
}

function ImageSettings({object, onUpdate, onClose, onDelete}: {
    object: SlideObject & {type: 'image'};
    onUpdate: (objId: string, updates: Partial<SlideObject>) => void;
    onClose: () => void;
    onDelete: (objId: string) => void;
}) {
    const originalRef = useRef({objectFit: object.objectFit});
    const [objectFit, setObjectFit] = useState(object.objectFit);

    const handleCancel = useCallback(() => {
        onUpdate(object.id, originalRef.current);
        onClose();
    }, [object.id, onUpdate, onClose]);

    return (
        <div className="grid gap-4 py-4">
            <div className="grid gap-2">
                <Label>Preview</Label>
                <div className="border rounded overflow-hidden">
                    <img src={object.src} alt="" className="max-h-32 mx-auto object-contain"/>
                </div>
            </div>
            <div className="grid gap-2">
                <Label>Fit</Label>
                <Select value={objectFit} onValueChange={(v) => { const val = v as 'contain' | 'cover' | 'fill'; setObjectFit(val); onUpdate(object.id, {objectFit: val}); }}>
                    <SelectTrigger><SelectValue/></SelectTrigger>
                    <SelectContent>
                        <SelectItem value="contain">Contain</SelectItem>
                        <SelectItem value="cover">Cover</SelectItem>
                        <SelectItem value="fill">Fill</SelectItem>
                    </SelectContent>
                </Select>
            </div>
            <DialogFooter className="sm:justify-between">
                <Button type="button" variant="destructive" onClick={() => { onDelete(object.id); onClose(); }}>Delete</Button>
                <div className="flex gap-2">
                    <Button type="button" variant="outline" onClick={handleCancel}>Cancel</Button>
                    <Button type="button" onClick={onClose}>Done</Button>
                </div>
            </DialogFooter>
        </div>
    );
}
