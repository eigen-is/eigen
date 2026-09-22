// First: a second API process on this data dir exits here, before any module opens a database.
import './instance-lock';

// Dynamic, so no bundle chunk the server pulls in can evaluate ahead of the lock.
await import('./server');

export type { App as app } from './app';
