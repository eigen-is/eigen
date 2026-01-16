import {app} from "./app";

app.listen(8000);

export type {App as app} from "./app";

// // Check setup status on startup
// Promise.all([isSystemConfigured(), isSetupRequired()]).then(([systemConfigured, userSetupRequired]) => {
//     if (!systemConfigured || userSetupRequired) {
//         console.log('⚠️  Setup required');
//         if (!systemConfigured) {
//             console.log('   - System configuration needed');
//         }
//         if (userSetupRequired) {
//             console.log('   - Admin user creation needed');
//         }
//         console.log('📋 Visit http://localhost:3010/admin to complete setup');
//     }
// });

console.log(
    `🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`,
);
