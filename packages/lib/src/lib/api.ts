import {edenTreaty} from "@elysiajs/eden/treaty";
import {app} from "@apps/api-server/src";

export const api = edenTreaty<app>('http://localhost:8000', {
    $fetch: {
        credentials: 'include'
    }
});

