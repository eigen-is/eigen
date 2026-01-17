import {treaty} from '@elysiajs/eden';
import type {app} from "@apps/api";

export const API_HOST = import.meta.env.VITE_API_HOST as string;

export const api = treaty<app>(API_HOST, {
    fetch: {
        credentials: 'include'
    }
});

export const contactsApi = api.contacts;
export const mailApi = api.mail;
export const spaceApi = api.space;
export const driveApi = api.drive;
export const homeApi = api.home;

export const adminApi = api.admin;

export const SSE_NOTIFICATIONS_URL = `${API_HOST}/sse/notifications`;