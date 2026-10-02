#!/usr/bin/env python3
"""W10 automatic node certificate smoke (called by smoke.sh).

A pebble ACME CA (+ pebble-challtestsrv as its DNS, every name -> 127.0.0.1)
runs in docker; the panel's [acme] directory_url points at it. Here:
  - a node is created with a TLS domain and three certificate templates
    (VLESS-WS-TLS, Trojan-TLS, Hysteria 2) that default to that domain,
  - an agent is started for it (answers HTTP-01 on 5002, pebble's port),
  - the agent obtains the certificate itself; the panel shows it valid,
  - handshakes on the TLS inbounds verify against pebble's root for the
    domain, and mihomo (when available) relays through all three proxies of
    the rendered subscription WITHOUT skip-cert-verify, trusting only that
    root (SSL_CERT_FILE),
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


try:
    # --- node with a TLS domain -------------------------------------------------
    p_ws, p_tr, p_hy = free_port(), free_port(), free_port()
    st, v = api("POST", "/api/v1/nodes", {
        "name": "acme-1",
        "server_addr": "127.0.0.1",
        "tls_domain": DOMAIN.upper(),
        "templates": [
            {"template": "vless_ws_tls", "port": p_ws, "tag": "acme-ws"},
            {"template": "trojan_tls", "port": p_tr, "tag": "acme-trojan"},
            {"template": "hysteria2", "port": p_hy, "tag": "acme-hy2"},
        ],
    })
    if st != 201:
        fail(f"create node with a TLS domain: {st} {v}")
    NODE = v["id"]
    st, nodes = api("GET", "/api/v1/nodes")
    n = [x for x in nodes if x["id"] == NODE][0]
    if n["tls_domain"] != DOMAIN:
        fail(f"tls_domain not stored normalized: {n['tls_domain']}")
    for i in n["xray_inbounds"]:
        if i["streamSettings"]["tlsSettings"]["serverName"] != DOMAIN:
            fail(f"{i['tag']}: SNI does not default to the node TLS domain")
    # A different certificate name is refused for this node.
    st, r = api("POST", "/api/v1/inbound-templates/render", {
        "templates": [{"template": "trojan_tls", "port": 1, "domain": "other.akari.test"}],
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
        st, nodes = api("GET", "/api/v1/nodes")
        n = [x for x in nodes if x["id"] == NODE][0]
        cert = (n.get("heartbeat") or {}).get("cert")
        if cert and cert["state"] == "valid":
            break
        time.sleep(1)
    else:
        fail(f"panel does not show a valid certificate: {cert}")
    if cert["domain"] != DOMAIN or not cert["not_after"] or cert["challenge"] != "http-01" or n["warnings"]:
        fail(f"certificate status: {cert} warnings={n['warnings']}")
    if n["agent_protocol"] < 6 or n["agent_addr"] != "127.0.0.1":
        fail(f"agent protocol/address: {n['agent_protocol']} {n['agent_addr']}")
    print(f"agent obtained the certificate for {DOMAIN} (valid until {cert['not_after']})")

    # --- handshakes verify against the CA's root ----------------------------------
    ctx0 = ssl.create_default_context()
    ctx0.check_hostname = False
    ctx0.verify_mode = ssl.CERT_NONE
    mgmt = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPSHandler(context=ctx0))
    with mgmt.open(MGMT + "/roots/0", timeout=10) as r:
        root = r.read()
    ROOT = os.path.join(DIR, "pebble-root.pem")
    open(ROOT, "wb").write(root)
    ctx = ssl.create_default_context(cafile=ROOT)
    for port in (p_ws, p_tr):
        with socket.create_connection(("127.0.0.1", port), timeout=5) as s:
            with ctx.wrap_socket(s, server_hostname=DOMAIN) as t:
                if not t.getpeercert():
                    fail(f"port {port}: no verified certificate")
    print("TLS handshakes verify against the CA root for the node domain")

    # --- a real client trusting only that root ------------------------------------
    st, u = api("POST", "/api/v1/users", {"login": "acme-user", "password": "user-password-123"})
    if st != 201:
        fail(f"create acme user: {st} {u}")
    USER, SUB = u["id"], u["sub_token"]
    for tag, proto in (("acme-ws", "vless"), ("acme-trojan", "trojan"), ("acme-hy2", "hysteria")):
        st, a = api("POST", f"/api/v1/users/{USER}/nodes/{NODE}", {"inbound_tag": tag, "protocol": proto})
        if st != 201:
            fail(f"assign {tag}: {st} {a}")
    st, clash = api("GET", f"/sub/{SUB}", ua="clash.meta/1.19", raw=True)
    clash = clash.decode()
    if clash.count(f"sni: {DOMAIN}") + clash.count(f"servername: {DOMAIN}") < 3 or "skip-cert-verify: true" in clash:
        fail(f"clash subscription does not carry the node domain as SNI:\n{clash}")
    mihomo = os.environ.get("MIHOMO_BIN") or os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "../../akari-client/bin/mihomo")
    if not os.access(mihomo, os.X_OK):
        print("mihomo: not available (MIHOMO_BIN) — real-client check skipped")
    else:
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
        cfg = clash.split("proxy-groups:")[0]
        names = [json.loads(l[len("  - name: "):]) for l in cfg.splitlines() if l.startswith("  - name: ")]
        ports = {}
        cfg = "log-level: warning\nallow-lan: false\nipv6: false\n" + cfg + "listeners:\n"
        for nm in names:
            ports[nm] = free_port()
            cfg += f"  - name: l{ports[nm]}\n    type: mixed\n    listen: 127.0.0.1\n    port: {ports[nm]}\n    proxy: {json.dumps(nm)}\n"
        cfg += "rules:\n  - MATCH,DIRECT\n"
        md = os.path.join(DIR, "mihomo")
        os.makedirs(md, exist_ok=True)
        open(os.path.join(md, "config.yaml"), "w").write(cfg)
        menv = dict(env, SSL_CERT_FILE=ROOT, SSL_CERT_DIR=DIR)
        procs.append(subprocess.Popen([mihomo, "-d", md, "-f", os.path.join(md, "config.yaml")],
                                      stdout=open(os.path.join(DIR, "mihomo.log"), "w"),
                                      stderr=subprocess.STDOUT, env=menv))
        url = f"http://127.0.0.1:{echo.server_address[1]}/"
        bad = []
        for nm, port in ports.items():
            ok = False
            for _ in range(15):
                r = subprocess.run(["curl", "-s", "-m", "8", "--noproxy", "", "-x", f"socks5h://127.0.0.1:{port}", url],
                                   capture_output=True, text=True, env=env)
                if r.stdout == "acme-ok":
                    ok = True
                    break
                time.sleep(1)
            if not ok:
                bad.append(nm)
        if len(ports) != 3 or bad:
            fail(f"mihomo: no relay through {bad or ports} (see {DIR}/mihomo.log)")
        print("mihomo: VLESS-WS-TLS, Trojan-TLS and Hysteria 2 relay with certificate verification on")

    api("DELETE", f"/api/v1/users/{USER}")
    st, _ = api("DELETE", f"/api/v1/nodes/{NODE}")
    if st not in (200, 202, 204):
        fail(f"delete acme node: {st}")
finally:
    cleanup()
print("w10 automatic certificate: ok")
