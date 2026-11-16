// The links the server's admin adds to the public site, such as "Try the demo" on eigen.is, as outline buttons.
// They come from the public config, so they appear once it has loaded. Pages such as the landing page show them
// beside their own buttons.

import { usePublicConfig } from '@workspace/lib/public';
import { Button } from '@workspace/ui/components/button';

export function LandingLinks() {
    const { data: config } = usePublicConfig();
    return config?.landingLinks.map((link) => (
        <Button key={`${link.title}:${link.url}`} variant="outline" className="px-6 py-2 flex-3" asChild>
            <a href={link.url} rel="noopener">
                {link.title}
            </a>
        </Button>
    ));
}
