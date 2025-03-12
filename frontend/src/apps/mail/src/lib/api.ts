import {edenTreaty} from "@elysiajs/eden/treaty";
import {type app} from '../../../../../../backend/src/all/src';

// @ts-ignore
export const api = edenTreaty<app>('http://localhost:8000', {
    $fetch: {
        credentials: 'include'
    }
});

