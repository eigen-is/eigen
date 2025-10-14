# Deployment Instructions

This project uses PHP for dynamic metadata on blog posts while remaining a static frontend application.

## How it works

1. **Build process** (`bun run build`):
   - First runs `scripts/generate-blog-meta.ts` to create `public/blog-meta.json`
   - Then builds the static assets with Vite

2. **Runtime**:
   - `index.php` serves the app and reads blog metadata from `blog-meta.json`
   - Metadata (title, description, OG tags) is dynamically inserted based on the URL
   - All routes are redirected to `index.php` via `.htaccess`

## Deployment Steps

### 1. Build the project
```bash
cd apps/index
bun run build
```

This creates:
- `public/blog-meta.json` - Blog post metadata
- `dist/` - Built static assets

### 2. Deploy to server

Upload these files to your web server:
- `index.php` - Main entry point
- `.htaccess` - URL rewriting rules
- `blog-meta.json` - Blog metadata (generated during build)
- `dist/*` - All built assets

### 3. Server Requirements

- PHP 7.4 or higher
- Apache with mod_rewrite enabled (or nginx with appropriate rewrite rules)

### Nginx Configuration (if not using Apache)

```nginx
location / {
    try_files $uri $uri/ /index.php?$args;
}

location ~ \.php$ {
    fastcgi_pass unix:/var/run/php/php-fpm.sock;
    fastcgi_index index.php;
    include fastcgi_params;
    fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
}
```

## Local Development

For local development, use Vite's dev server:
```bash
bun run dev
```

Note: During development, the dynamic metadata from PHP won't work. You'll see the default metadata from TanStack Router's `head` function instead.

## Notes

- The `index.html` file is kept for local development but is not used in production
- Blog posts are stored in `src/data/blog/*.md` with frontmatter
- Metadata is automatically extracted during build time
- The PHP file only serves metadata - all functionality is client-side React
