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
            try {
                const yColumns = doc.getArray('columns');

                if (type === 'column') {
                    // Move column
                    const column = yColumns.get(source.index);
                    if (column) {
                        yColumns.delete(source.index);
                        yColumns.insert(destination.index, [column]);
                    }
                } else {
                    // Card dragging - use the columnId from the droppableId
                    const sourceColumnId = source.droppableId;
                    const destColumnId = destination.droppableId;
                    
                    // Find indices of columns by their IDs
                    let sourceColumnIndex = -1;
                    let destColumnIndex = -1;
                    
                    for (let i = 0; i < yColumns.length; i++) {
                        const colId = yColumns.get(i).get('id');
                        if (colId === sourceColumnId) sourceColumnIndex = i;
                        if (colId === destColumnId) destColumnIndex = i;
                    }
                    
                    if (sourceColumnIndex === -1) {
                        console.error(`Source column with ID ${sourceColumnId} not found`);
                        return;
                    }
                    
                    if (destColumnIndex === -1) {
                        console.error(`Destination column with ID ${destColumnId} not found`);
                        return;
                    }
                    
                    // Get the source and destination columns
                    const sourceColumn = yColumns.get(sourceColumnIndex) as Y.Map<any>;
                    const destColumn = yColumns.get(destColumnIndex) as Y.Map<any>;
                    
                    if (!sourceColumn) {
                        console.error(`Source column at index ${sourceColumnIndex} not found`);
                        return;
                    }
                    
                    if (!destColumn) {
                        console.error(`Destination column at index ${destColumnIndex} not found`);
                        return;
                    }
                    
                    // Get cards array from source column
                    const yCards = sourceColumn.get('cards') as Y.Array<any>;
                    if (!yCards) {
                        console.error('Source column cards array not found');
                        return;
                    }
                    
                    // Get the card being moved
                    const card = yCards.get(source.index);
                    if (!card) {
                        console.error(`Card at index ${source.index} not found in source column`);
                        return;
                    }
                    
                    // Clone the card to preserve all properties
                    const cardClone = new Y.Map();
                    // Copy all properties from the original card
                    for (const [key, value] of card.entries()) {
                        cardClone.set(key, value);
                    }
                    
                    // Remove card from source column
                    yCards.delete(source.index);
                    
                    // Add card to destination column
                    if (sourceColumnId === destColumnId) {
                        // Same column, just reinsert at the new position
                        yCards.insert(destination.index, [cardClone]);
                    } else {
                        // Different column, get destination cards array
                        const destCards = destColumn.get('cards') as Y.Array<any>;
                        if (!destCards) {
                            console.error('Destination column cards array not found');
                            return;
                        }
                        destCards.insert(destination.index, [cardClone]);
                    }
                }
            } catch (error) {
                console.error('Error during drag and drop operation:', error);
            }
        });
    };

    const handleAddCard = (columnIndex: number) => {
        doc.transact(() => {
            const yColumns = doc.getArray('columns');
            const yColumn = yColumns.get(columnIndex) as Y.Map<any>;
            if (!yColumn) return;
            
            const yCards = yColumn.get('cards') as Y.Array<any>;
            if (!yCards) return;
            
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
            
            {/* Disable the react-beautiful-dnd strict mode warnings in development */}
            <div
                style={{
                    overflow: 'hidden',
                    display: 'flex',
                    flexDirection: 'column',
                    height: 'calc(100vh - 120px)',
                }}
            >
                <DragDropContext onDragEnd={handleDragEnd}>
                    <Droppable
                        droppableId="board"
                        type="column"
                        direction="horizontal"
                        isDropDisabled={false}
                    >
                        {(provided) => (
                            <div
                                {...provided.droppableProps}
                                ref={provided.innerRef}
                                className="flex gap-4 p-4 overflow-x-auto h-full"
                                style={{ maxHeight: 'calc(100vh - 140px)' }}
                            >
                                {columns.map((column, index) => (
                                    <Draggable
                                        key={column.id}
                                        draggableId={column.id}
                                        index={index}
                                    >
                                        {(provided) => (
                                            <div
                                                {...provided.draggableProps}
                                                ref={provided.innerRef}
                                                className="flex flex-col w-72 bg-gray-50 rounded-md shadow shrink-0"
                                            >
                                                <div 
                                                    {...provided.dragHandleProps} 
                                                    className="font-bold p-3 border-b flex justify-between items-center"
                                                >
                                                    <h2>{column.title}</h2>
                                                    <button 
                                                        onClick={() => handleAddCard(index)}
                                                        className="text-sm bg-gray-200 hover:bg-gray-300 px-2 py-1 rounded"
                                                    >
                                                        + Add
                                                    </button>
                                                </div>
                                                
                                                <Droppable
                                                    droppableId={column.id}
                                                    type="card"
                                                    isDropDisabled={false}
                                                >
                                                    {(provided) => (
                                                        <div
                                                            ref={provided.innerRef}
                                                            {...provided.droppableProps}
                                                            className="min-h-[200px] p-2 overflow-y-auto flex-grow"
                                                            style={{ maxHeight: 'calc(100vh - 200px)' }}
                                                        >
                                                            {column.cards.map((card, cardIndex) => (
                                                                <CardComponent
                                                                    key={card.id}
                                                                    card={card}
                                                                    index={cardIndex}
                                                                    yCard={(() => {
                                                                        try {
                                                                            const columnObj = doc.getArray('columns').get(index);
                                                                            if (!columnObj) return undefined;
                                                                            const cardsArray = columnObj.get('cards');
                                                                            if (!cardsArray) return undefined;
                                                                            return cardsArray.get(cardIndex);
                                                                        } catch (error) {
                                                                            console.error('Error getting yCard reference:', error);
                                                                            return undefined;
                                                                        }
                                                                    })()}
                                                                    onDelete={(cardId) => {
                                                                        doc.transact(() => {
                                                                            try {
                                                                                const yColumns = doc.getArray('columns');
                                                                                const yColumn = yColumns.get(index) as Y.Map<any>;
                                                                                if (!yColumn) return;
                                                                                
                                                                                const yCards = yColumn.get('cards') as Y.Array<any>;
                                                                                if (!yCards) return;
                                                                                
                                                                                const cardIndex = column.cards.findIndex(c => c.id === cardId);
                                                                                if (cardIndex !== -1) {
                                                                                    yCards.delete(cardIndex);
                                                                                }
                                                                            } catch (error) {
                                                                                console.error('Error deleting card:', error);
                                                                            }
                                                                        });
                                                                    }}
                                                                />
                                                            ))}
                                                            {provided.placeholder}
                                                        </div>
                                                    )}
                                                </Droppable>
                                            </div>
                                        )}
                                    </Draggable>
                                ))}
                                {provided.placeholder}
                            </div>
                        )}
                    </Droppable>
                </DragDropContext>
            </div>
        </div>
    );
}
