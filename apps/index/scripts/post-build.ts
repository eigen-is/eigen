import {copyFileSync, existsSync, readFileSync, writeFileSync} from 'fs';
import {join} from 'path';

function postBuild() {
    const distDir = join(process.cwd(), 'dist');
    
    if (!existsSync(distDir)) {
        console.error('Error: dist directory does not exist. Run build first.');
        process.exit(1);
    }

    // Read the generated index.html to extract script and link tags
    const indexHtmlPath = join(distDir, 'index.html');
    const indexHtmlContent = readFileSync(indexHtmlPath, 'utf-8');
    
    // Extract script tags and link tags (for CSS)
    const scriptMatch = indexHtmlContent.match(/<script[^>]*src="([^"]+)"[^>]*><\/script>/);
    const linkMatches = indexHtmlContent.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g);
    
    const scriptSrc = scriptMatch ? scriptMatch[1] : '/src/main.tsx';
    const cssLinks = Array.from(linkMatches).map(match => match[0]).join('\n    ');
    
    // Read the PHP template
    const indexPhpTemplate = readFileSync(join(process.cwd(), 'index.php'), 'utf-8');
    
    // Replace the script src and add CSS links
    let indexPhpContent = indexPhpTemplate.replace(
        '<script src="/src/main.tsx" type="module"></script>',
        `<script src="${scriptSrc}" type="module"></script>`
    );
    
    // Add CSS links before </head>
    if (cssLinks) {
        indexPhpContent = indexPhpContent.replace(
            '</head>',
            `    ${cssLinks}\n</head>`
        );
    }
    
    // Write the updated index.php
    const indexPhpDest = join(distDir, 'index.php');
    writeFileSync(indexPhpDest, indexPhpContent);
    console.log('Generated index.php with correct asset paths');

    // Copy .htaccess
    const htaccessSrc = join(process.cwd(), '.htaccess');
    const htaccessDest = join(distDir, '.htaccess');
    copyFileSync(htaccessSrc, htaccessDest);
    console.log('Copied .htaccess to dist/');

    console.log('Post-build completed successfully!');
}

postBuild();
