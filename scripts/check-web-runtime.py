"""Verify deployed HTML and its same-origin CSS/JS."""

import argparse
from html.parser import HTMLParser
from urllib.parse import urljoin, urlparse
from urllib.request import Request, urlopen


def fetch(url):
    return urlopen(Request(url, headers={"User-Agent": "Jood-Monitor-Runtime-Check/0.1.0"}), timeout=20)


class Assets(HTMLParser):
    def __init__(self):
        super().__init__()
        self.paths = set()

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "script" and attrs.get("src"):
            self.paths.add((attrs["src"], "javascript"))
        if tag == "link" and attrs.get("rel") in {"stylesheet", "modulepreload"}:
            self.paths.add((attrs["href"], "css" if attrs["rel"] == "stylesheet" else "javascript"))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("origin")
    parser.add_argument("routes", nargs="+")
    args = parser.parse_args()
    checked = set()
    for route in args.routes:
        url = urljoin(args.origin, route)
        with fetch(url) as response:
            assert response.status == 200, (route, response.status)
            assert "text/html" in response.headers.get("Content-Type", ""), route
            html = response.read().decode()
        assert "The server could not finish this Suspense boundary" not in html, (route, "SSR fallback")
        assert "$RX(" not in html, (route, "failed React Suspense boundary")
        assets = Assets()
        assets.feed(html)
        assert any(kind == "css" for _, kind in assets.paths), (route, "missing stylesheet")
        assert any(kind == "javascript" for _, kind in assets.paths), (route, "missing client script")
        for path, kind in sorted(assets.paths):
            asset = urljoin(url, path)
            assert urlparse(asset).netloc == urlparse(args.origin).netloc, (path, "unexpected asset origin")
            if asset in checked:
                continue
            with fetch(asset) as response:
                assert response.status == 200, (path, response.status)
                assert kind in response.headers.get("Content-Type", ""), (path, "wrong asset content type")
                assert response.read(), (path, "empty asset")
            checked.add(asset)
        print(f"rendered {route}; referenced CSS and JavaScript verified")
    print(f"verified {len(checked)} distinct assets")


if __name__ == "__main__":
    main()
