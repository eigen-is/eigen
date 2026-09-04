import { mergeConfig } from 'vite';
import { createAppConfig } from '../../vite.shared.config';

export default mergeConfig(createAppConfig('slides'), {
    cacheDir: './node_modules/.vite-verify',
    server: { port: 3912, strictPort: true },
});
