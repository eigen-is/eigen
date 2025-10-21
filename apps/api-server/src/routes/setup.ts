import { Elysia, t } from "elysia";
import { isSetupRequired, createFirstAdminUser } from "../lib/setup/setup";

export const setupRouter = new Elysia({ prefix: "/setup" })
    .get("/required", async () => {
        const required = await isSetupRequired();
        return { setupRequired: required };
    })
    .post("/admin", async ({ body, set }) => {
        // Check if setup is still required
        const required = await isSetupRequired();
        if (!required) {
            set.status = 403;
            return { error: "Setup has already been completed" };
        }

        const { username, password, name } = body;
        
        // Basic validation
        if (!username || !password || !name) {
            set.status = 400;
            return { error: "Username, password, and name are required" };
        }

        if (password.length < 8) {
            set.status = 400;
            return { error: "Password must be at least 8 characters long" };
        }

        // Append @eigen.is to username to create email
        const email = `${username}@eigen.is`;

        const result = await createFirstAdminUser(email, password, name);
        
        if (!result.success) {
            set.status = 400;
            return { error: result.error };
        }

        return { 
            success: true, 
            message: "Admin user created successfully",
            user: {
                id: result.user?.id,
                email: result.user?.email,
                name: result.user?.name
            }
        };
    }, {
        body: t.Object({
            username: t.String({ minLength: 1 }),
            password: t.String({ minLength: 8 }),
            name: t.String({ minLength: 1 })
        })
    })
    .get("/", async ({ set }) => {
        const required = await isSetupRequired();
        if (!required) {
            set.redirect = "/";
            return;
        }

        // Return a simple HTML setup page
        set.headers['content-type'] = 'text/html';
        return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Eigen Setup - Create Admin User</title>
    <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-50 min-h-screen flex items-center justify-center">
    <div class="max-w-md w-full space-y-8 p-8">
        <div class="text-center">
            <h2 class="mt-6 text-3xl font-extrabold text-gray-900">
                Welcome to Eigen
            </h2>
            <p class="mt-2 text-sm text-gray-600">
                Create your first admin user to get started
            </p>
        </div>
        
        <form id="setupForm" class="mt-8 space-y-6">
            <div class="space-y-4">
                <div>
                    <label for="name" class="block text-sm font-medium text-gray-700">Full Name</label>
                    <input id="name" name="name" type="text" required 
                           class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500">
                </div>
                
                <div>
                    <label for="username" class="block text-sm font-medium text-gray-700">Username</label>
                    <div class="mt-1 flex rounded-md shadow-sm">
                        <input id="username" name="username" type="text" required 
                               class="flex-1 block w-full px-3 py-2 border border-gray-300 rounded-l-md focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                               placeholder="username">
                        <span class="inline-flex items-center px-3 rounded-r-md border border-l-0 border-gray-300 bg-gray-50 text-gray-500 text-sm">
                            @eigen.is
                        </span>
                    </div>
                </div>
                
                <div>
                    <label for="password" class="block text-sm font-medium text-gray-700">Password</label>
                    <input id="password" name="password" type="password" required minlength="8"
                           class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500">
                    <p class="mt-1 text-xs text-gray-500">Must be at least 8 characters long</p>
                </div>
            </div>

            <div id="error" class="hidden bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded"></div>
            <div id="success" class="hidden bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded"></div>

            <button type="submit" id="submitBtn"
                    class="group relative w-full flex justify-center py-2 px-4 border border-transparent text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed">
                Create Admin User
            </button>
        </form>
    </div>

    <script>
        document.getElementById('setupForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const submitBtn = document.getElementById('submitBtn');
            const errorDiv = document.getElementById('error');
            const successDiv = document.getElementById('success');
            
            // Hide previous messages
            errorDiv.classList.add('hidden');
            successDiv.classList.add('hidden');
            
            // Disable submit button
            submitBtn.disabled = true;
            submitBtn.textContent = 'Creating...';
            
            const formData = new FormData(e.target);
            const data = {
                name: formData.get('name'),
                username: formData.get('username'),
                password: formData.get('password')
            };
            
            try {
                const response = await fetch('/setup/admin', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify(data)
                });
                
                const result = await response.json();
                
                if (response.ok && result.success) {
                    successDiv.textContent = result.message + '. Redirecting to login...';
                    successDiv.classList.remove('hidden');
                    
                    // Redirect to main app after 2 seconds
                    setTimeout(() => {
                        window.location.href = '/';
                    }, 2000);
                } else {
                    errorDiv.textContent = result.error || 'An error occurred';
                    errorDiv.classList.remove('hidden');
                }
            } catch (error) {
                errorDiv.textContent = 'Network error. Please try again.';
                errorDiv.classList.remove('hidden');
            } finally {
                submitBtn.disabled = false;
                submitBtn.textContent = 'Create Admin User';
            }
        });
    </script>
</body>
</html>
        `;
    });
