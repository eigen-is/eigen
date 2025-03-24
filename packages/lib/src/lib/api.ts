import { edenTreaty } from '@elysiajs/eden';
import type { app } from "@apps/api-server";

export const api = edenTreaty<app>('https://eigen.is:8000', {
    $fetch: {
        credentials: 'include'
    }
});

export const contactsApi = api.contacts;