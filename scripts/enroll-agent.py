#!/usr/bin/env python3
"""Exchange a private one-use enrollment token without printing the cluster credential."""
import argparse
import json
import os
from pathlib import Path
import urllib.request
from urllib.parse import urlparse


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("origin")
    parser.add_argument("cluster_id")
    parser.add_argument("token_file", type=Path)
    parser.add_argument("credential_file", type=Path)
    args = parser.parse_args()
    origin = urlparse(args.origin)
    if origin.scheme != "https" or not origin.hostname or origin.username or origin.password or origin.path or origin.query or origin.fragment:
        parser.error("use an exact HTTPS origin")
    if args.credential_file.exists():
        parser.error("refusing to overwrite an existing credential")
    if os.name == "posix" and args.token_file.stat().st_mode & 0o077:
        parser.error("enrollment token file must be private (chmod 600)")
    token = args.token_file.read_text().strip()
    if any(character.isspace() for character in token):
        parser.error("enrollment token file must hold only the token, on one line")
    request = urllib.request.Request(args.origin+"/machine/v1/enroll", data=json.dumps({"clusterId":args.cluster_id}).encode(), headers={"Content-Type":"application/json", "Authorization":"Bearer "+token}, method="POST")
    opener = urllib.request.build_opener(NoRedirect())
    with opener.open(request,timeout=20) as response:
        result = json.load(response)
    descriptor = os.open(args.credential_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor,"w") as output:
        output.write(result["credential"]+"\n")
    print("Scoped credential saved privately at",args.credential_file)


if __name__ == "__main__":
    main()
