import { edenTreaty } from '@elysiajs/eden';
import type { app } from "@apps/api-server";

export const api = edenTreaty<app>('http://localhost:8000', {
    $fetch: {
        credentials: 'include'
    }
});

export const contactsApi = api.contacts;