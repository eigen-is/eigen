import { edenTreaty } from '@elysiajs/eden';
import type { app } from "@apps/api-server";

// Use a default API host for browser environments
// In development, the API server typically runs on port 8000
const API_HOST = typeof process !== 'undefined' && process.env.API_HOST 
    ? process.env.API_HOST 
    : 'http://localhost:8000';

export const api = edenTreaty<app>(API_HOST, {
    fetcher: async (url, options = {}) => {
        // Always include credentials for cross-origin requests
        options.credentials = 'include';
        return fetch(url, options);
    }
});

export const contactsApi = api.contacts;