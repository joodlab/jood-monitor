"""Verify a redirected enrollment request never transmits its token to the destination."""
import importlib.util
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import threading
import urllib.error
import urllib.request

spec = importlib.util.spec_from_file_location("enroll",Path(__file__).with_name("enroll-agent.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
received = []


class Destination(BaseHTTPRequestHandler):
    def do_GET(self):
        received.append(self.headers.get("Authorization"))
        self.send_response(200)
        self.end_headers()

    do_POST = do_GET

    def log_message(self,*args):
        pass


destination = ThreadingHTTPServer(("127.0.0.1",0),Destination)


class Redirect(BaseHTTPRequestHandler):
    def do_POST(self):
        self.send_response(302)
        self.send_header("Location",f"http://127.0.0.1:{destination.server_port}/credential-destination")
        self.end_headers()

    def log_message(self,*args):
        pass


source = ThreadingHTTPServer(("127.0.0.1",0),Redirect)
for server in [source,destination]:
    threading.Thread(target=server.serve_forever,daemon=True).start()
try:
    request = urllib.request.Request(f"http://127.0.0.1:{source.server_port}/enroll",data=b"{}",headers={"Authorization":"Bearer fixture-non-secret"},method="POST")
    try:
        urllib.request.build_opener(urllib.request.ProxyHandler({}),module.NoRedirect()).open(request,timeout=5)
        raise AssertionError("enrollment redirect accepted")
    except urllib.error.HTTPError as error:
        assert error.code == 302
    assert received == [], "enrollment credential forwarded"
    # Prove this fixture detects the default urllib POST-to-GET credential leak.
    with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request,timeout=5) as response:
        assert response.status == 200
    assert received == ["Bearer fixture-non-secret"], "fixture did not exercise redirect leak"
    print("enrollment redirect rejected; destination received no credential/request")
finally:
    for server in [source,destination]:
        server.shutdown()
        server.server_close()
