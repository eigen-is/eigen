import {edenTreaty} from "@elysiajs/eden/treaty";
import {app} from "@apps/api-server/src";

export const api = edenTreaty<app>(process.env.API_HOST as string, {
    $fetch: {
        credentials: 'include'
    }
});

