import {treaty} from '@elysiajs/eden';
import type {app} from "@apps/api-server";

export const api = treaty<app>(import.meta.env.VITE_API_HOST as string, {
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