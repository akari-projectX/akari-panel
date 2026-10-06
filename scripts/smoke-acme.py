#!/usr/bin/env python3
"""W10 automatic node certificate smoke (called by smoke.sh).

A pebble ACME CA (+ pebble-challtestsrv as its DNS, every name -> 127.0.0.1)
runs in docker; the panel's ACME directory (系统设置 → 节点通信, imported
from smoke's obsolete [acme] directory_url) points at it. Here:
  - a node is created with a TLS domain and a certificate template
    (Trojan-TLS) that defaults to that domain,
  - an agent is started for it (answers HTTP-01 on 5002, pebble's port),
  - the agent obtains the certificate itself; the panel shows it valid,
  - the node's inbound then becomes each of Trojan-TLS, VLESS-WS-TLS and
    Hysteria 2 in turn (W28-a/D2: one inbound per node): TCP handshakes
    verify against pebble's root for the domain, and mihomo (when
    available) relays through the rendered subscription's proxy WITHOUT
    skip-cert-verify, trusting only that root (SSL_CERT_FILE),
  - the DNS pre-flight endpoint answers.

Env: BASE, JAR, LOG, AGENT (binary), PEBBLE_API_ROOT (pebble's HTTPS cert
root), PEBBLE_MGMT (https://127.0.0.1:15000).
"""

import json
import os
import shutil
import signal
import socket
import ssl
import subprocess
import sys
import threading
import time
import http.server
import urllib.error
import urllib.request

BASE = os.environ["BASE"]
JAR = os.environ["JAR"]
LOG = os.environ["LOG"]
AGENT = os.environ["AGENT"]
API_ROOT = os.environ["PEBBLE_API_ROOT"]
MGMT = os.environ.get("PEBBLE_MGMT", "https://127.0.0.1:15000")
DIR = os.path.join(LOG, "acme")
os.makedirs(DIR, exist_ok=True)
DOMAIN = "node.akari.test"


def fail(msg):
    print(f"FAIL: {msg}")
    sys.exit(1)


def cookie():
    for line in open(JAR):
        line = line.strip()
        if line.startswith("#HttpOnly_"):
            line = line[len("#HttpOnly_"):]
        if not line or line.startswith("#"):
            continue
        parts = line.split("\t")
        if len(parts) >= 7:
            return f"{parts[5]}={parts[6]}"
    fail("no session cookie in the jar")


COOKIE = cookie()
NOPROXY = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def api(method, path, body=None, ua=None, raw=False):
    req = urllib.request.Request(BASE + path, method=method)
    req.add_header("Cookie", COOKIE)
    if ua:
        req.add_header("User-Agent", ua)
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        req.add_header("Content-Type", "application/json")
    try:
        with NOPROXY.open(req, data=data, timeout=20) as r:
            b = r.read()
            return r.status, (b if raw else (json.loads(b) if b else None))
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(errors="replace")


_handed_out = set()


def free_port(exclude=()):
    # The kernel may hand the same ephemeral port out twice (each probe
    # socket is closed at once): never return a port twice per run.
    while True:
        s = socket.socket()
        s.bind(("127.0.0.1", 0))
        p = s.getsockname()[1]
        s.close()
        if p not in _handed_out and p not in exclude:
            _handed_out.add(p)
            return p


procs = []


def cleanup():
    for p in procs:
        p.terminate()
        try:
            p.wait(5)
        except subprocess.TimeoutExpired:
            p.kill()


def node_view(node):
    st, n = api("GET", f"/api/v1/nodes/{node}")
    if st != 200:
        fail(f"GET node: {st} {n}")
    return n


def wait_applied(node, agent_log, before, port, udp):
    deadline = time.time() + 30
    while time.time() < deadline:
        n = node_view(node)
        if n["last_error"] is None and open(agent_log).read().count('"msg":"state applied"') > before:
            if udp:
                return
            try:
                socket.create_connection(("127.0.0.1", port), timeout=1).close()
                return
            except OSError:
                pass
        time.sleep(0.5)
    fail(f"the agent did not apply the inbound on port {port} (last_error={n['last_error']})")


try:
    # --- node with a TLS domain -------------------------------------------------
    p_ws, p_tr, p_hy = free_port(), free_port(), free_port()
    st, v = api("POST", "/api/v1/nodes", {
        "name": "acme-1",
        "direct": {"connect_host": "127.0.0.1"},
        "tls_domain": DOMAIN.upper(),
        "template": {"template": "trojan_tls", "port": p_tr},
    })
    if st != 201:
        fail(f"create node with a TLS domain: {st} {v}")
    NODE = v["id"]
    n = node_view(NODE)
    if n["tls_domain"] != DOMAIN:
        fail(f"tls_domain not stored normalized: {n['tls_domain']}")
    if n["inbound"]["streamSettings"]["tlsSettings"]["serverName"] != DOMAIN:
        fail("SNI does not default to the node TLS domain")
    DIRECT = [e["id"] for e in n["entrances"] if e["kind"] == "direct"][0]
    # A different certificate name is refused for this node.
    st, r = api("POST", "/api/v1/inbound-templates/render", {
        "template": {"template": "trojan_tls", "port": 1, "domain": "other.akari.test"},
        "tls_domain": DOMAIN})
    if st != 400:
        fail(f"render with a foreign certificate domain: {st} {r}")
    # DNS pre-flight answers (warn only; the smoke host cannot resolve .test).
    st, c = api("POST", "/api/v1/inbound-templates/check-domain", {"domain": DOMAIN, "node_id": NODE})
    if st != 200 or c["domain"] != DOMAIN or c["expected"] != ["127.0.0.1"]:
        fail(f"check-domain: {st} {c}")

    # --- the agent obtains the certificate --------------------------------------
    boot = os.path.join(DIR, "bootstrap.toml")
    open(boot, "w").write(v["bootstrap"])
    os.chmod(boot, 0o600)
    state = os.path.join(DIR, "state")
    os.makedirs(state, exist_ok=True)
    agent_log = os.path.join(DIR, "agent.log")
    env = {k: val for k, val in os.environ.items() if k.lower() not in ("http_proxy", "https_proxy", "all_proxy")}
    procs.append(subprocess.Popen(
        [AGENT, "-config", boot, "-state-dir", state, "-acme-roots", API_ROOT,
         "-acme-http-port", "5002", "-acme-tls-port", "5001"],
        stdout=open(agent_log, "w"), stderr=subprocess.STDOUT, env=env))
    deadline = time.time() + 90
    while time.time() < deadline:
        if '"msg":"node certificate stored"' in open(agent_log).read():
            break
        time.sleep(0.5)
    else:
        print(open(agent_log).read()[-3000:])
        fail("the agent did not obtain the certificate")
    if "TLS inbounds now serve the CA-issued node certificate" not in open(agent_log).read():
        time.sleep(1)
        if "TLS inbounds now serve the CA-issued node certificate" not in open(agent_log).read():
            fail("the TLS inbounds were not switched to the issued certificate")
    for f in ("fullchain.pem", "privkey.pem"):
        mode = os.stat(os.path.join(state, "tls", DOMAIN, f)).st_mode & 0o777
        if mode != 0o600:
            fail(f"{f} mode {oct(mode)}")
    # The panel shows it (next heartbeat, every 15 s).
    deadline = time.time() + 45
    cert = None
    while time.time() < deadline:
        n = node_view(NODE)
        cert = (n.get("heartbeat") or {}).get("cert")
        if cert and cert["state"] == "valid":
            break
        time.sleep(1)
    else:
        fail(f"panel does not show a valid certificate: {cert}")
    warnings = [w for w in n["warnings"] if "akari-agent-update" not in w]  # W18 updater hint
    if cert["domain"] != DOMAIN or not cert["not_after"] or cert["challenge"] != "http-01" or warnings:
        fail(f"certificate status: {cert} warnings={n['warnings']}")
    if n["agent_protocol"] < 6 or n["agent_addr"] != "127.0.0.1":
        fail(f"agent protocol/address: {n['agent_protocol']} {n['agent_addr']}")
    print(f"agent obtained the certificate for {DOMAIN} (valid until {cert['not_after']})")

    ctx0 = ssl.create_default_context()
    ctx0.check_hostname = False
    ctx0.verify_mode = ssl.CERT_NONE
    mgmt = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPSHandler(context=ctx0))
    with mgmt.open(MGMT + "/roots/0", timeout=10) as r:
        root = r.read()
    ROOT = os.path.join(DIR, "pebble-root.pem")
    open(ROOT, "wb").write(root)
    ctx = ssl.create_default_context(cafile=ROOT)

    # --- a user (D3: through a plan granting the node's direct entrance) ----------
    st, u = api("POST", "/api/v1/users", {"email": "acme-user@smoke.test", "password": "user-password-123"})
    if st != 201:
        fail(f"create acme user: {st} {u}")
    USER, SUB = u["id"], u["sub_token"]
    st, g = api("POST", "/api/v1/node-groups", {"name": "acme-group", "entrance_ids": [DIRECT]})
    if st != 201:
        fail(f"create acme group: {st} {g}")
    st, pl = api("POST", "/api/v1/plans", {"name": "acme-plan", "period": "monthly", "group_ids": [g["id"]]})
    if st != 201:
        fail(f"create acme plan: {st} {pl}")
    st, r = api("PUT", f"/api/v1/users/{USER}/plan", {"plan_id": pl["id"], "period": "month"})
    if st != 200:
        fail(f"acme user plan: {st} {r}")

    mihomo = os.environ.get("MIHOMO_BIN") or os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "../../akari-client/bin/mihomo")
    if not os.access(mihomo, os.X_OK):
        mihomo = None
        print("mihomo: not available (MIHOMO_BIN) — real-client check skipped")

    class Echo(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.send_header("Content-Length", "7")
            self.end_headers()
            self.wfile.write(b"acme-ok")

        def log_message(self, *a):
            pass

    echo = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Echo)
    threading.Thread(target=echo.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{echo.server_address[1]}/"

    # --- each certificate template in turn -----------------------------------------
    steps = [
        ("Trojan-TLS", None, p_tr, False),
        ("VLESS-WS-TLS", {"template": "vless_ws_tls", "port": p_ws}, p_ws, False),
        ("Hysteria 2", {"template": "hysteria2", "port": p_hy}, p_hy, True),
    ]
    for label, spec, port, udp in steps:
        if spec is not None:
            st, r = api("POST", "/api/v1/inbound-templates/render", {"template": spec, "tls_domain": DOMAIN})
            if st != 200 or not r["needs_certificate"]:
                fail(f"render {label}: {st} {r}")
            before = open(agent_log).read().count('"msg":"state applied"')
            st, r = api("PUT", f"/api/v1/nodes/{NODE}/inbound", {"inbound": r["inbound"]})
            if st != 200:
                fail(f"put {label}: {st} {r}")
            wait_applied(NODE, agent_log, before, port, udp)
        if not udp:
            # The handshake verifies against the CA's root for the node domain.
            with socket.create_connection(("127.0.0.1", port), timeout=5) as s:
                with ctx.wrap_socket(s, server_hostname=DOMAIN) as t:
                    if not t.getpeercert():
                        fail(f"{label}: no verified certificate")
        st, clash = api("GET", f"/sub/{SUB}", ua="clash.meta/1.19", raw=True)
        clash = clash.decode()
        if clash.count(f"sni: {DOMAIN}") + clash.count(f"servername: {DOMAIN}") < 1 or "skip-cert-verify: true" in clash:
            fail(f"{label}: clash subscription does not carry the node domain as SNI:\n{clash}")
        if not mihomo:
            continue
        cfg = clash.split("proxy-groups:")[0]
        names = [json.loads(l[len("  - name: "):]) for l in cfg.splitlines() if l.startswith("  - name: ")]
        if len(names) != 1:
            fail(f"{label}: {len(names)} proxies in the subscription")
        lport = free_port()
        cfg = ("log-level: warning\nallow-lan: false\nipv6: false\n" + cfg + "listeners:\n"
               f"  - name: l{lport}\n    type: mixed\n    listen: 127.0.0.1\n    port: {lport}\n"
               f"    proxy: {json.dumps(names[0])}\nrules:\n  - MATCH,DIRECT\n")
        md = os.path.join(DIR, "mihomo")
        os.makedirs(md, exist_ok=True)
        open(os.path.join(md, "config.yaml"), "w").write(cfg)
        menv = dict(env, SSL_CERT_FILE=ROOT, SSL_CERT_DIR=DIR)
        mp = subprocess.Popen([mihomo, "-d", md, "-f", os.path.join(md, "config.yaml")],
                              stdout=open(os.path.join(DIR, f"mihomo-{port}.log"), "w"),
                              stderr=subprocess.STDOUT, env=menv)
        procs.append(mp)
        for _ in range(15):
            r = subprocess.run(["curl", "-s", "-m", "8", "--noproxy", "", "-x", f"socks5h://127.0.0.1:{lport}", url],
                               capture_output=True, text=True, env=env)
            if r.stdout == "acme-ok":
                break
            time.sleep(1)
        else:
            fail(f"mihomo: no relay through {label} (see {DIR}/mihomo-{port}.log)")
        mp.terminate()
        mp.wait(5)
        procs.remove(mp)
    print("TLS handshakes verify against the CA root for the node domain")
    if mihomo:
        print("mihomo: Trojan-TLS, VLESS-WS-TLS and Hysteria 2 relay with certificate verification on")

    api("DELETE", f"/api/v1/users/{USER}?confirm=true")
    st, _ = api("DELETE", f"/api/v1/nodes/{NODE}")
    if st not in (200, 202, 204):
        fail(f"delete acme node: {st}")
    for path in (f"/api/v1/plans/{pl['id']}", f"/api/v1/node-groups/{g['id']}"):
        st, _ = api("DELETE", path)
        if st != 204:
            fail(f"delete {path}: {st}")
finally:
    cleanup()
print("w10 automatic certificate: ok")
