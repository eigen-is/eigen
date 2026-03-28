import { defineConfig } from 'drizzle-kit';

export default defineConfig({
    dialect: 'sqlite',
    schema: './auth-schema.ts',
    dbCredentials: {
        url: '../../../../eigen/api/data/users3.db',
    },
});
