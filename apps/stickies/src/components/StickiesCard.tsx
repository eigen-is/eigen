import React, { useEffect, useState, useCallback } from 'react';
import { Draggable } from 'react-beautiful-dnd';
import * as Y from 'yjs';
import { Button } from "@workspace/ui/components/button";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogFooter
} from "@workspace/ui/components/dialog";
import { Input } from "@workspace/ui/components/input";
import { Textarea } from "@workspace/ui/components/textarea";
import { Edit, Trash2, MoreHorizontal } from "lucide-react";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger
} from "@workspace/ui/components/dropdown-menu";

// Performance-optimized card component with Yjs integration
const CardComponent = React.memo(({
                                      card,
                                      index,
                                      yCard,
                                      onDelete
                                  }: {
    card: { id: string; title: string; description: string; labels?: string[] };
    index: number;
    yCard: Y.Map<any> | undefined;
    onDelete?: (cardId: string) => void;
}) => {
    const [isEditing, setIsEditing] = useState(false);
    const [localTitle, setLocalTitle] = useState(card.title);
    const [localDescription, setLocalDescription] = useState(card.description);

    // Listen for changes to the card from Yjs
    useEffect(() => {
        // Skip if yCard is undefined
        if (!yCard) return;

        const observer = () => {
            setLocalTitle(yCard.get('title'));
            setLocalDescription(yCard.get('description'));
        };

        yCard.observe(observer);

        return () => {
            yCard.unobserve(observer);
        };
    }, [yCard]);

    // Apply card changes to Yjs
    const handleSaveCard = useCallback(() => {
        if (!yCard || !yCard.doc) return;
        
        yCard.doc.transact(() => {
            yCard.set('title', localTitle);
            yCard.set('description', localDescription);
        });
        setIsEditing(false);
    }, [yCard, localTitle, localDescription]);

    // Map label colors
    const getLabelColor = (label: string) => {
        const colors: Record<string, string> = {
            'bug': 'bg-red-100 text-red-800',
            'feature': 'bg-blue-100 text-blue-800',
            'enhancement': 'bg-green-100 text-green-800',
            'documentation': 'bg-purple-100 text-purple-800',
            'question': 'bg-yellow-100 text-yellow-800',
        };

        return colors[label] || 'bg-gray-100 text-gray-800';
    };

    return (
        <>
            <Draggable draggableId={card.id} index={index}>
                {(provided, snapshot) => (
                    <div
                        ref={provided.innerRef}
                        {...provided.draggableProps}
                        {...provided.dragHandleProps}
                        className={`bg-white rounded-md shadow-sm p-3 mb-2 ${snapshot.isDragging ? 'shadow-md' : ''}`}
                    >
                        <div className="flex justify-between items-start">
                            <h3 className="font-medium text-sm line-clamp-2">{card.title}</h3>

                            <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                    <Button variant="ghost" size="sm" className="h-6 w-6 p-0">
                                        <MoreHorizontal className="h-4 w-4" />
                                        <span className="sr-only">Actions</span>
                                    </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                    <DropdownMenuItem onClick={() => setIsEditing(true)}>
                                        <Edit className="mr-2 h-4 w-4" />
                                        <span>Edit</span>
                                    </DropdownMenuItem>
                                    {onDelete && (
                                        <DropdownMenuItem onClick={() => onDelete(card.id)}>
                                            <Trash2 className="mr-2 h-4 w-4" />
                                            <span>Delete</span>
                                        </DropdownMenuItem>
                                    )}
                                </DropdownMenuContent>
                            </DropdownMenu>
                        </div>

                        {card.description && (
                            <p className="text-xs text-muted-foreground mt-2 line-clamp-3">
                                {card.description}
                            </p>
                        )}

                        {card.labels && card.labels.length > 0 && (
                            <div className="flex flex-wrap gap-1 mt-2">
                                {card.labels.map((label) => (
                                    <span
                                        key={label}
                                        className={`text-xs px-2 py-0.5 rounded-full ${getLabelColor(label)}`}
                                    >
                    {label}
                  </span>
                                ))}
                            </div>
                        )}
                    </div>
                )}
            </Draggable>

            {/* Edit Dialog */}
            <Dialog open={isEditing} onOpenChange={setIsEditing}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Edit Card</DialogTitle>
                    </DialogHeader>

                    <div className="grid gap-4 py-4">
                        <div className="grid gap-2">
                            <label htmlFor="title" className="text-sm font-medium">Title</label>
                            <Input
                                id="title"
                                value={localTitle}
                                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setLocalTitle(e.target.value)}
                            />
                        </div>

                        <div className="grid gap-2">
                            <label htmlFor="description" className="text-sm font-medium">Description</label>
                            <Textarea
                                id="description"
                                value={localDescription}
                                onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setLocalDescription(e.target.value)}
                                className="min-h-[100px]"
                            />
                        </div>
                    </div>

                    <DialogFooter>
                        <Button variant="outline" onClick={() => setIsEditing(false)}>
                            Cancel
                        </Button>
                        <Button onClick={handleSaveCard}>
                            Save
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
});


export default CardComponent;
