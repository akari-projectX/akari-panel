#!/usr/bin/env python3
"""A tiny Cloudflare API for the admin e2e (scripts/e2e.sh starts it on loopback and
points the panel at it with AKARI_TEST_LIMITS cloudflare_mock_port).

usage: cloudflare-mock.py PORT GOOD_TOKEN

Tokens: GOOD_TOKEN sees two zones (e2e-dns.test editable, e2e-ro.test read-only);
any other token is answered like an invalid one. Zone ids are 32 x "a" / "b".
"""
import json
import re
import sys
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT, TOKEN = int(sys.argv[1]), sys.argv[2]
ZONES = {
    "a" * 32: ("e2e-dns.test", ["#zone:read", "#dns_records:edit"]),
    "b" * 32: ("e2e-ro.test", ["#zone:read", "#dns_records:read"]),
}
RECS = {z: [] for z in ZONES}
SEQ = [0]


def add(zone, **kw):
    SEQ[0] += 1
    r = dict(kw, id="%032x" % SEQ[0], zone_id=zone, zone_name=ZONES[zone][0], proxiable=kw["type"] in ("A", "AAAA", "CNAME"),
             modified_on="2026-10-26T00:00:00Z")
    r.setdefault("ttl", 1)
    r.setdefault("comment", "")
    RECS[zone].append(r)
    return r


Z = "a" * 32
add(Z, type="A", name="www.e2e-dns.test", content="203.0.113.10", proxied=True)
add(Z, type="A", name="origin.e2e-dns.test", content="203.0.113.11", proxied=False, ttl=300)
add(Z, type="TXT", name="e2e-dns.test", content="v=spf1 -all", ttl=3600)
for i in range(1, 56):
    add(Z, type="A", name="p%02d.e2e-dns.test" % i, content="198.51.100.%d" % i, proxied=False, ttl=300)
add("b" * 32, type="A", name="ro.e2e-dns.test", content="203.0.113.50", proxied=False)


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def out(self, code, result=None, errors=None, info=None):
        body = {"success": not errors, "errors": errors or [], "result": result}
        if info:
            body["result_info"] = info
        b = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def handle_any(self):
        n = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(n)) if n else None
        if self.headers.get("Authorization") != "Bearer " + TOKEN:
            return self.out(401, errors=[{"code": 9109, "message": "Invalid access token"}])
        u = urllib.parse.urlparse(self.path)
        q = dict(urllib.parse.parse_qsl(u.query))
        if u.path == "/client/v4/zones":
            rows = [{"id": i, "name": n, "status": "active", "paused": False, "permissions": p} for i, (n, p) in ZONES.items()]
            return self.out(200, rows, info={"page": 1, "per_page": 50, "total_count": len(rows), "total_pages": 1})
        m = re.fullmatch(r"/client/v4/zones/([0-9a-f]{32})/dns_records(?:/([0-9a-f]{32}))?", u.path)
        if not m or m.group(1) not in ZONES:
            return self.out(404, errors=[{"code": 7003, "message": "no route"}])
        zone, rid = m.group(1), m.group(2)
        recs = RECS[zone]
        if rid is None and self.command == "GET":
            s = q.get("search", "").lower()
            rows = [r for r in recs if q.get("type", r["type"]) == r["type"] and (s in r["name"].lower() or s in str(r.get("content", "")).lower())]
            per, page = int(q.get("per_page", 50)), int(q.get("page", 1))
            pages = max(1, -(-len(rows) // per))
            return self.out(200, rows[(page - 1) * per : page * per],
                            info={"page": page, "per_page": per, "total_count": len(rows), "total_pages": pages})
        if rid is None and self.command == "POST":
            if any(r["name"] == body["name"] and r["type"] == body["type"] and r.get("content") == body.get("content") for r in recs):
                return self.out(400, errors=[{"code": 81058, "message": "A record with those settings already exists."}])
            return self.out(200, add(zone, **body))
        r = next((x for x in recs if x["id"] == rid), None)
        if r is None:
            return self.out(404, errors=[{"code": 81044, "message": "Record does not exist."}])
        if self.command == "GET":
            return self.out(200, r)
        if self.command in ("PATCH", "PUT"):
            r.update(body)
            return self.out(200, r)
        recs.remove(r)
        return self.out(200, {"id": rid})

    do_GET = do_POST = do_PATCH = do_PUT = do_DELETE = handle_any


ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
