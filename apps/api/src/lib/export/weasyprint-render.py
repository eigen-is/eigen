# Renders the HTML on stdin to a PDF on stdout. WeasyPrint's own fetcher opens any URL the HTML names, from the API
# host, and an export embeds everything it needs as a data: URI, so this one opens data: URIs and refuses the rest:
# http(s), file:, a path, any other scheme.
import sys

import weasyprint


def refuse_all_but_data(url):
    if not url.lower().startswith('data:'):
        raise ValueError(f'only data: URIs are fetched, not {url[:80]}')


# WeasyPrint 68 replaced default_url_fetcher with the URLFetcher class, and 69 takes only a fetcher of that class.
if hasattr(weasyprint.urls, 'URLFetcher'):

    class DataFetcher(weasyprint.urls.URLFetcher):
        def fetch(self, url, headers=None):
            refuse_all_but_data(url)
            return super().fetch(url, headers)

    fetcher = DataFetcher()
else:

    def fetcher(url):
        refuse_all_but_data(url)
        return weasyprint.default_url_fetcher(url)


weasyprint.HTML(file_obj=sys.stdin.buffer, encoding='utf-8', url_fetcher=fetcher).write_pdf(sys.stdout.buffer)
