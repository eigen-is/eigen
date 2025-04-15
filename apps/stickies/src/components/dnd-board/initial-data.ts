import {BoardData} from './types';

const now = Date.now();
const defaultCreator = 'reinder@eigen.is';

export const initialData: BoardData = {
    tasks: {
        'task-1': {
            id: 'task-1',
            title: 'Take out the garbage',
            description: 'The garbage needs to be taken out before collection day.',
            creator: defaultCreator,
            createdAt: now,
            comments: [
                {
                    id: 'comment-1',
                    text: 'This is important!',
                    author: defaultCreator,
                    createdAt: now
                }
            ]
        },
        'task-2': {
            id: 'task-2',
            title: 'Watch my favorite show',
            description: 'The new episode is out today.',
            creator: defaultCreator,
            createdAt: now,
            comments: []
        },
        'task-3': {
            id: 'task-3',
            title: 'Charge my phone',
            description: 'Battery is getting low.',
            creator: defaultCreator,
            createdAt: now,
            comments: []
        },
        'task-4': {
            id: 'task-4',
            title: 'Cook dinner',
            description: 'Need to prepare something for tonight.',
            creator: defaultCreator,
            createdAt: now,
            comments: []
        },
    },
    columns: {
        'column-1': {
            id: 'column-1',
            title: 'To do',
            taskIds: ['task-1', 'task-2', 'task-3', 'task-4'],
            creator: defaultCreator,
            createdAt: now
        },
        'column-2': {
            id: 'column-2',
            title: 'In progress',
            taskIds: [],
            creator: defaultCreator,
            createdAt: now
        },
        'column-3': {
            id: 'column-3',
            title: 'Done',
            taskIds: [],
            creator: defaultCreator,
            createdAt: now
        },
    },
    columnOrder: ['column-1', 'column-2', 'column-3'],
};
