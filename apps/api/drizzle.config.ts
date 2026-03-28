import { defineConfig } from 'drizzle-kit';

export default defineConfig({
    dialect: 'sqlite',
    schema: './auth-schema.ts',
    dbCredentials: {
        url: '../../data/server/users3.db',
    },
});
