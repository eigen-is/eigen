# Renders the HTML on stdin to a PDF on stdout. WeasyPrint's own fetcher opens any URL the HTML names, from the API
# host, and an export embeds everything it needs as a data: URI, so this one opens data: URIs and refuses the rest:
# http(s), file:, a path, any other scheme. Needs WeasyPrint 68, the first with the URLFetcher class.
import sys

import weasyprint


# Not URLFetcher(allowed_protocols={'data'}): 68.0 takes the text before '://' as the scheme, so it refuses every data:.
class DataFetcher(weasyprint.urls.URLFetcher):
    def fetch(self, url, headers=None):
        if not url.lower().startswith('data:'):
            raise ValueError(f'only data: URIs are fetched, not {url[:80]}')
        return super().fetch(url, headers)


weasyprint.HTML(file_obj=sys.stdin.buffer, encoding='utf-8', url_fetcher=DataFetcher()).write_pdf(sys.stdout.buffer)
