import base from './vite.config.ts';
export default async (env: any) => {
    const cfg = typeof base === 'function' ? await (base as any)(env) : base;
    return {
        ...cfg,
        cacheDir:
            '/private/tmp/claude-502/-Users-reinder-Documents-GitHub-eigen/4e655f89-cfc7-4777-9e47-fbfbaea38792/scratchpad/verify-ua/.vite-ua',
        server: { ...(cfg.server || {}), port: 3914, strictPort: true, host: '127.0.0.1' },
    };
};
