import {edenTreaty} from '@elysiajs/eden';
import type {app} from "@apps/api-server";

// export const api = edenTreaty<app>('https://eigen.is:8000', {
export const api = edenTreaty<app>(import.meta.env.VITE_API_HOST, {
    $fetch: {
        credentials: 'include'
    }
});

export const contactsApi = api.contacts;
export const mailApi = api.mail;
