import React, { useState, useEffect, useRef, useReducer } from 'react';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { DragDropContext, Droppable, Draggable } from 'react-beautiful-dnd';
import { nanoid } from 'nanoid';
import CardComponent from './StickiesCard';

// Helper functions to convert Yjs data to React state
const mapYjsToCards = (yCards: Y.Array<any>) => {
  return yCards.toArray().map((card: Y.Map<any>) => ({
    id: card.get('id'),
    title: card.get('title'),
    description: card.get('description'),
    labels: card.get('labels')
  }));
};

const mapYjsToColumns = (yColumns: Y.Array<any>) => {
  return yColumns.toArray().map((column: Y.Map<any>) => ({
    id: column.get('id'),
    title: column.get('title'),
    cards: mapYjsToCards(column.get('cards'))
  }));
};

interface StickiesBoardProps {
  ownerId: string;
  pathId: string;
}

export function StickiesBoard({ ownerId, pathId }: StickiesBoardProps) {
    const [columns, setColumns] = useState<Array<{ id: string; title: string; cards: Array<any> }>>([]);
    const doc = useRef(new Y.Doc()).current;
    const wsProvider = useRef<WebsocketProvider | null>(null);

    useEffect(() => {        
        try {
            
            // Build WebSocket URL
            const wsUrl = `${import.meta.env.VITE_API_HOST}/ws/collab/${ownerId}/${pathId}`;
            const slug = '';

            // Create WebSocket provider
            wsProvider.current  = new WebsocketProvider(wsUrl, slug, doc, {
                resyncInterval: 5000,
                connect: true,
            });
            
            console.log('WebSocket provider created:', wsProvider.current);
            
            // Explicitly connect (in case it didn't auto-connect)
            wsProvider.current.connect();
            console.log('WebSocket connect called');
            
            // Log connection status changes
            const provider = wsProvider.current;
            
            // Handle provider errors
            provider.on('connection-error', (event: Event) => {
                console.error('WebSocket connection error:', event);
            });
            
            provider.on('status', ({ status }: { status: string }) => {
                console.log(`WebSocket Status: ${status}`);
            });
            
            // Listen for sync status to initialize document if empty
            provider.on('sync', (isSynced: boolean) => {
                console.log(`Document synced: ${isSynced}`);
                
                if (isSynced) {
                    // Now we're sure we're synced with the server
                    // getArray automatically creates the array if it doesn't exist
                    const yColumns = doc.getArray('columns');
                    console.log(`Initial columns length: ${yColumns.length}`);
                    
                    // Log the full Yjs document state
                    console.log('Current document state:', doc.toJSON());
                    
                    // Initialize with default columns if empty
                    if (yColumns.length === 0) {
                        console.log('Creating default columns...');
                        doc.transact(() => {
                            // Create default columns
                            ['To Do', 'In Progress', 'Done'].forEach(title => {
                                const yColumn = new Y.Map();
                                yColumn.set('id', nanoid());
                                yColumn.set('title', title);
                                yColumn.set('cards', new Y.Array());
                                yColumns.push([yColumn]);
                            });
                        });
                        console.log('Default columns created. New length:', yColumns.length);
                        console.log('Updated document state:', doc.toJSON());
                    }
                }
            });
        } catch (error) {
            console.error('Error setting up WebSocket provider:', error);
        }

        // Listen for changes in the document
        const yColumns = doc.getArray('columns');

        const observer = () => {
            // Map Yjs structure to React state
            const mappedColumns = mapYjsToColumns(yColumns);
            console.log('Document changed. Current columns:', mappedColumns);
            setColumns(mappedColumns);
        };

        yColumns.observe(observer);
        observer(); // Initial render

        return () => {
            console.log('Cleaning up WebSocket connection');
            yColumns.unobserve(observer);
            if (wsProvider.current) {
                try {
                    wsProvider.current.disconnect();
                    console.log('WebSocket disconnected');
                } catch (error) {
                    console.error('Error disconnecting WebSocket:', error);
                }
            }
        };
    }, [ownerId, pathId, doc]);

    // Handle drag and drop with react-beautiful-dnd
    const handleDragEnd = (result: any) => {
        if (!result.destination) return;

        const { source, destination, type } = result;

        // Transaction for optimistic UI updates
        doc.transact(() => {
            const yColumns = doc.getArray('columns');

            if (type === 'column') {
                // Move column
                const column = yColumns.get(source.index);
                yColumns.delete(source.index);
                yColumns.insert(destination.index, [column]);
            } else {
                // Move card
                const sourceColumn = yColumns.get(parseInt(source.droppableId));
                const destColumn = yColumns.get(parseInt(destination.droppableId));

                const yCards = sourceColumn.get('cards');
                const card = yCards.get(source.index);

                // Remove card from source column
                yCards.delete(source.index);

                // Add card to destination column
                if (source.droppableId === destination.droppableId) {
                    yCards.insert(destination.index, [card]);
                } else {
                    const destCards = destColumn.get('cards');
                    destCards.insert(destination.index, [card]);
                }
            }
        });
    };

    const handleAddCard = (columnIndex: number) => {
        doc.transact(() => {
            const yColumns = doc.getArray('columns');
            const yColumn = yColumns.get(columnIndex);
            const yCards = yColumn.get('cards');
            
            const newCard = new Y.Map();
            newCard.set('id', nanoid());
            newCard.set('title', 'New Card');
            newCard.set('description', '');
            
            yCards.push([newCard]);
        });
    };

    return (
        <div className="p-4 h-full">
            <h1 className="text-2xl font-bold mb-4">Stickies Board</h1>
            
            <DragDropContext onDragEnd={handleDragEnd}>
                <Droppable droppableId="board" type="column" direction="horizontal">
                    {(provided) => (
                        <div
                            {...provided.droppableProps}
                            ref={provided.innerRef}
                            className="flex gap-4 overflow-x-auto p-4"
                        >
                            {columns.map((column, index) => (
                                <ColumnComponent
                                    key={column.id}
                                    column={column}
                                    index={index}
                                    yColumn={doc.getArray('columns').get(index)}
                                    onAddCard={() => handleAddCard(index)}
                                />
                            ))}
                            {provided.placeholder}
                        </div>
                    )}
                </Droppable>
            </DragDropContext>
        </div>
    );
}

// Performance-optimized column component
interface ColumnProps {
    column: { id: string; title: string; cards: Array<any> };
    index: number;
    yColumn: Y.Map<any>;
    onAddCard: () => void;
}

const ColumnComponent = React.memo(({ column, index, yColumn, onAddCard }: ColumnProps) => {
    // UseRef for stable render identity
    const cardsRef = useRef<Array<any>>([]);

    useEffect(() => {
        const yCards = yColumn.get('cards');

        const observer = () => {
            cardsRef.current = mapYjsToCards(yCards);
            forceUpdate();
        };

        yCards.observe(observer);
        observer(); // Initial render

        return () => yCards.unobserve(observer);
    }, [yColumn]);

    // Used to force a render without updating the entire app
    const [, forceUpdate] = useReducer(x => x + 1, 0);

    const handleDeleteCard = (cardId: string) => {
        const yCards = yColumn.get('cards');
        yColumn.doc?.transact(() => {
            const index = cardsRef.current.findIndex(card => card.id === cardId);
            if (index !== -1) {
                yCards.delete(index);
            }
        });
    };

    return (
        <Draggable draggableId={column.id} index={index}>
            {(provided) => (
                <div
                    {...provided.draggableProps}
                    ref={provided.innerRef}
                    className="flex flex-col w-72 bg-gray-50 rounded-md shadow"
                >
                    <div 
                        {...provided.dragHandleProps} 
                        className="font-bold p-3 border-b flex justify-between items-center"
                    >
                        <h2>{column.title}</h2>
                        <button 
                            onClick={onAddCard}
                            className="text-sm bg-gray-200 hover:bg-gray-300 px-2 py-1 rounded"
                        >
                            + Add
                        </button>
                    </div>
                    
                    <Droppable droppableId={String(index)} type="card">
                        {(provided) => (
                            <div
                                ref={provided.innerRef}
                                {...provided.droppableProps}
                                className="min-h-[200px] p-2 overflow-y-auto flex-grow"
                            >
                                {cardsRef.current.map((card, cardIndex) => (
                                    <CardComponent
                                        key={card.id}
                                        card={card}
                                        index={cardIndex}
                                        yCard={yColumn.get('cards').get(cardIndex)}
                                        onDelete={handleDeleteCard}
                                    />
                                ))}
                                {provided.placeholder}
                            </div>
                        )}
                    </Droppable>
                </div>
            )}
        </Draggable>
    );
});
