#!/usr/bin/env python3
"""W8 protocol matrix smoke (called by smoke.sh with the agent running).

For every inbound template: render it through the panel API, put it on the
smoke node (127.0.0.1, a throwaway self-signed certificate in place of the
node's certificate files, a local TLS 1.3 site as the REALITY target),
assign one user to every inbound, and check
  - the agent applies the whole set (no last_error, a fresh "state applied"),
  - the three subscription formats carry correct entries (and leave out
    what a format cannot express: xhttp in sing-box),
  - with real clients when available (mihomo: MIHOMO_BIN or
    ../akari-client/bin/mihomo; sing-box: SINGBOX_BIN), every proxy of the
    rendered subscription relays HTTP through the agent, and deleting the
    user cuts new connections (gate + validator).
The node's previous inbounds are restored at the end.

Env: BASE, JAR, NODE_ID, LOG (smoke log dir), AGENT_LOG.
"""

import base64
import http.server
import json
import os
import shutil
import socket
import ssl
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

BASE = os.environ["BASE"]
JAR = os.environ["JAR"]
NODE_ID = os.environ["NODE_ID"]
LOG = os.environ["LOG"]
AGENT_LOG = os.environ["AGENT_LOG"]
W8 = os.path.join(LOG, "w8")
os.makedirs(W8, exist_ok=True)

CERT_FILE = "/run/credentials/akari-agent.service/tls_fullchain.pem"
KEY_FILE = "/run/credentials/akari-agent.service/tls_privkey.pem"
DOMAIN = "w8.test"


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


# --- local helpers -------------------------------------------------------------

subprocess.run(
    ["openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
     "-nodes", "-days", "1", "-subj", f"/CN={DOMAIN}", "-addext", f"subjectAltName=DNS:{DOMAIN}",
     "-keyout", f"{W8}/privkey.pem", "-out", f"{W8}/fullchain.pem"],
    check=True, capture_output=True)


class Echo(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = b"w8-ok"
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


echo = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Echo)
threading.Thread(target=echo.serve_forever, daemon=True).start()
ECHO_URL = f"http://127.0.0.1:{echo.server_address[1]}/"

# REALITY target: a TLS 1.3 site (h2 offered) on localhost.
tls_ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
tls_ctx.minimum_version = ssl.TLSVersion.TLSv1_3
tls_ctx.load_cert_chain(f"{W8}/fullchain.pem", f"{W8}/privkey.pem")
tls_ctx.set_alpn_protocols(["h2", "http/1.1"])
dest = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Echo)
dest.socket = tls_ctx.wrap_socket(dest.socket, server_side=True)
threading.Thread(target=dest.serve_forever, daemon=True).start()
DEST = f"localhost:{dest.server_address[1]}"

# --- templates -----------------------------------------------------------------

st, nodes = api("GET", "/api/v1/nodes")
node = [n for n in nodes if n["id"] == NODE_ID][0]
original = node["xray_inbounds"]
taken = [i["port"] for i in original if isinstance(i.get("port"), int)]

real = {"dest": DEST, "server_name": DOMAIN}
T = [  # (expected protocol, template spec without port)
    ("vless", dict(template="vless_reality", tag="w8-reality-vision", **real)),
    ("vless", dict(template="vless_reality_xhttp", tag="w8-reality-xhttp", path="/rx", **real)),
    ("vless", dict(template="vless_tls_vision", tag="w8-tls-vision", domain=DOMAIN)),
    ("vless", dict(template="vless_ws_tls", tag="w8-vless-ws-tls", domain=DOMAIN)),
    ("vless", dict(template="transport", tag="w8-vless-hu", protocol="vless", network="httpupgrade")),
    ("vless", dict(template="transport", tag="w8-vless-hu-tls", protocol="vless", network="httpupgrade", tls_domain=DOMAIN)),
    ("vless", dict(template="transport", tag="w8-vless-xhttp", protocol="vless", network="xhttp")),
    ("vless", dict(template="transport", tag="w8-vless-xhttp-tls", protocol="vless", network="xhttp", tls_domain=DOMAIN)),
    ("vless", dict(template="transport", tag="w8-vless-grpc", protocol="vless", network="grpc", tls_domain=DOMAIN, service_name="w8svc")),
    ("vmess", dict(template="vmess_tcp", tag="w8-vmess-tcp")),
    ("vmess", dict(template="vmess_ws", tag="w8-vmess-ws")),
    ("vmess", dict(template="transport", tag="w8-vmess-grpc", protocol="vmess", network="grpc", tls_domain=DOMAIN)),
    ("trojan", dict(template="trojan_tls", tag="w8-trojan-tls", domain=DOMAIN)),
    ("trojan", dict(template="transport", tag="w8-trojan-ws", protocol="trojan", network="ws", tls_domain=DOMAIN)),
    ("trojan", dict(template="transport", tag="w8-trojan-grpc", protocol="trojan", network="grpc", tls_domain=DOMAIN)),
    ("shadowsocks", dict(template="shadowsocks_2022", tag="w8-ss128")),
    ("shadowsocks", dict(template="shadowsocks_2022", tag="w8-ss256", method="2022-blake3-aes-256-gcm")),
    ("hysteria", dict(template="hysteria2", tag="w8-hy2", domain=DOMAIN)),
]
specs = []
for _, spec in T:
    specs.append(dict(spec, port=free_port(exclude=taken)))
rendered = []
for k in range(0, len(specs), 9):  # the API renders at most 16 at once
    st, r = api("POST", "/api/v1/inbound-templates/render",
                {"templates": specs[k:k + 9], "taken_ports": taken + [i["port"] for i in rendered]})
    if st != 200:
        fail(f"render templates: {st} {r}")
    if not r["needs_certificate"]:
        fail("render: certificate templates not flagged")
    rendered += r["inbounds"]
for i in rendered:
    i["listen"] = "127.0.0.1"
    for c in i.get("streamSettings", {}).get("tlsSettings", {}).get("certificates", []):
        if c.get("certificateFile") != CERT_FILE or c.get("keyFile") != KEY_FILE:
            fail(f"{i['tag']}: template does not read the node certificate files")
        c["certificateFile"] = f"{W8}/fullchain.pem"
        c["keyFile"] = f"{W8}/privkey.pem"

applied_before = open(AGENT_LOG).read().count('"msg":"state applied"')
st, r = api("PUT", f"/api/v1/nodes/{NODE_ID}/inbounds", {"inbounds": original + rendered})
if st != 200:
    fail(f"put rendered inbounds: {st} {r}")

st, u = api("POST", "/api/v1/users", {"login": "w8-user", "password": "user-password-123"})
if st != 201:
    fail(f"create w8 user: {st} {u}")
USER, SUB = u["id"], u["sub_token"]
for (proto, spec), inb in zip(T, rendered):
    if inb["protocol"] != proto:
        fail(f"{spec['tag']}: rendered protocol {inb['protocol']} != {proto}")
    st, a = api("POST", f"/api/v1/users/{USER}/nodes/{NODE_ID}", {"inbound_tag": inb["tag"], "protocol": proto})
    if st != 201:
        fail(f"assign {inb['tag']}: {st} {a}")
    acc = a["account"]
    want_flow = "xtls-rprx-vision" if spec["template"] in ("vless_reality", "vless_tls_vision") else ""
    if proto == "vless" and acc.get("flow") != want_flow:
        fail(f"{inb['tag']}: account flow {acc.get('flow')!r}, want {want_flow!r}")
    if proto == "shadowsocks":
        n = 32 if "256" in inb["settings"]["method"] else 16
        if len(base64.b64decode(acc["password"])) != n:
            fail(f"{inb['tag']}: user key is not {n} bytes")
    if proto == "hysteria" and len(acc.get("auth", "")) != 64:
        fail(f"{inb['tag']}: hysteria auth missing")

# --- the agent applies everything ------------------------------------------------

deadline = time.time() + 30
while time.time() < deadline:
    st, nodes = api("GET", "/api/v1/nodes")
    n = [x for x in nodes if x["id"] == NODE_ID][0]
    applied = open(AGENT_LOG).read().count('"msg":"state applied"')
    if n["last_error"] is None and applied > applied_before and not n["warnings"]:
        # the last apply must have every port listening
        ok = True
        for i in rendered:
            if i["protocol"] == "hysteria":
                continue
            s = socket.socket()
            s.settimeout(1)
            try:
                s.connect(("127.0.0.1", i["port"]))
            except OSError:
                ok = False
            finally:
                s.close()
        if ok:
            break
    time.sleep(1)
else:
    fail(f"agent did not apply the matrix (last_error={n['last_error']}, warnings={n['warnings']})")
if any('"level":"ERROR"' in line and "apply" in line for line in open(AGENT_LOG).readlines()[-50:]):
    fail("agent logged an apply error")
print(f"agent applied {len(rendered)} template inbounds")

# --- subscriptions ----------------------------------------------------------------

st, body = api("GET", f"/sub/{SUB}", ua="v2rayN/7.0", raw=True)
links = base64.b64decode(body.strip()).decode().splitlines()
if len(links) != len(rendered):
    fail(f"links: {len(links)} lines for {len(rendered)} inbounds")
by_tag = {}
for line in links:
    tag = urllib.request.unquote(line.rsplit("#", 1)[1]).split(" · ")[-1] if "#" in line else None
    if line.startswith("vmess://"):
        tag = json.loads(base64.b64decode(line[8:]))["ps"].split(" · ")[-1]
    by_tag[tag] = line
expect_links = {
    "w8-reality-vision": ["vless://", "type=tcp", "security=reality", "flow=xtls-rprx-vision", "pbk=", "sid=", "fp=chrome"],
    "w8-reality-xhttp": ["type=xhttp", "security=reality", "path=%2Frx", "mode=auto"],
    "w8-tls-vision": ["type=tcp", "security=tls", "flow=xtls-rprx-vision", f"sni={DOMAIN}"],
    "w8-vless-ws-tls": ["type=ws", "security=tls"],
    "w8-vless-hu": ["type=httpupgrade", "path="],
    "w8-vless-hu-tls": ["type=httpupgrade", "security=tls"],
    "w8-vless-xhttp": ["type=xhttp", "mode=auto"],
    "w8-vless-xhttp-tls": ["type=xhttp", "security=tls"],
    "w8-vless-grpc": ["type=grpc", "serviceName=w8svc", "mode=gun", "security=tls"],
    "w8-trojan-tls": ["trojan://", "type=tcp", "security=tls"],
    "w8-trojan-ws": ["trojan://", "type=ws", "security=tls"],
    "w8-trojan-grpc": ["trojan://", "type=grpc", "mode=gun"],
    "w8-ss128": ["ss://2022-blake3-aes-128-gcm:"],
    "w8-ss256": ["ss://2022-blake3-aes-256-gcm:"],
    "w8-hy2": ["hysteria2://", f"sni={DOMAIN}"],
}
for tag, parts in expect_links.items():
    line = by_tag.get(tag, "")
    for p in parts:
        if p not in line:
            fail(f"links: {tag} lacks {p!r}: {line}")
for tag, net in (("w8-vmess-tcp", "tcp"), ("w8-vmess-ws", "ws"), ("w8-vmess-grpc", "grpc")):
    v = json.loads(base64.b64decode(by_tag[tag][8:]))
    if v["net"] != net or v["aid"] != "0" or v["scy"] != "auto":
        fail(f"links: vmess {tag}: {v}")
for tag in ("w8-ss128", "w8-ss256"):
    user = by_tag[tag].split("@")[0][len("ss://"):]
    method, pw = user.split(":", 1)
    psk, key = urllib.request.unquote(pw).split(":")
    inb = [i for i in rendered if i["tag"] == tag][0]
    if psk != inb["settings"]["password"]:
        fail(f"links: {tag} server PSK mismatch")

st, clash = api("GET", f"/sub/{SUB}", ua="clash.meta/1.19", raw=True)
clash = clash.decode()
proxies = clash.count("\n  - name: ") + clash.startswith("  - name: ") - 1  # minus the group
if proxies != len(rendered):
    fail(f"clash: {proxies} proxies for {len(rendered)} inbounds")
for want in ("type: ss\n", "cipher: 2022-blake3-aes-256-gcm", "type: hysteria2\n", "network: xhttp\n",
             "v2ray-http-upgrade: true", "grpc-service-name: w8svc", "flow: xtls-rprx-vision"):
    if want not in clash:
        fail(f"clash lacks {want!r}")

st, sb = api("GET", f"/sub/{SUB}", ua="sing-box/1.12.0")
outs = [o for o in sb["outbounds"] if o["type"] != "direct"]
xhttp = [i for i in rendered if i.get("streamSettings", {}).get("network") == "xhttp"]
if len(outs) != len(rendered) - len(xhttp):
    fail(f"sing-box: {len(outs)} outbounds, want {len(rendered) - len(xhttp)} (xhttp left out)")
types = {o["type"] for o in outs}
for t in ("vless", "vmess", "trojan", "shadowsocks", "hysteria2"):
    if t not in types:
        fail(f"sing-box lacks {t}")
if not any(o.get("transport", {}).get("type") == "httpupgrade" for o in outs):
    fail("sing-box lacks the httpupgrade transport")
if not any(o.get("transport", {}).get("type") == "grpc" for o in outs):
    fail("sing-box lacks the grpc transport")
print("subscriptions: links/clash/sing-box carry the matrix")

# --- real clients ---------------------------------------------------------------------

procs = []


def curl_via(port):
    r = subprocess.run(["curl", "-s", "-m", "8", "-x", f"socks5h://127.0.0.1:{port}", ECHO_URL],
                       capture_output=True, text=True)
    return r.stdout == "w8-ok"


def wait_listen(port, t=15):
    end = time.time() + t
    while time.time() < end:
        s = socket.socket()
        try:
            s.connect(("127.0.0.1", port))
            return True
        except OSError:
            time.sleep(0.2)
        finally:
            s.close()
    return False


def mihomo_run(binary):
    # The rendered subscription, pointed at 127.0.0.1, self-signed accepted,
    # one mixed listener per proxy.
    lines = []
    skipped = False  # one skip-cert-verify per proxy (trojan has tls + sni)
    for line in clash.splitlines():
        if line.startswith("  - name: "):
            skipped = False
        if line.startswith("    server: "):
            line = "    server: 127.0.0.1"
        lines.append(line)
        if not skipped and (line == "    tls: true" or line.startswith("    sni: ")):
            lines.append("    skip-cert-verify: true")
            skipped = True
    cfg = "\n".join(lines).split("proxy-groups:")[0]
    names = [json.loads(l[len("  - name: "):]) for l in cfg.splitlines() if l.startswith("  - name: ")]
    ports = {}
    cfg = "log-level: warning\nallow-lan: false\nipv6: false\n" + cfg + "listeners:\n"
    for n in names:
        ports[n] = free_port()
        cfg += f"  - name: l{ports[n]}\n    type: mixed\n    listen: 127.0.0.1\n    port: {ports[n]}\n    proxy: {json.dumps(n)}\n"
    cfg += "rules:\n  - MATCH,DIRECT\n"
    d = os.path.join(W8, "mihomo")
    os.makedirs(d, exist_ok=True)
    open(os.path.join(d, "config.yaml"), "w").write(cfg)
    p = subprocess.Popen([binary, "-d", d, "-f", os.path.join(d, "config.yaml")],
                         stdout=open(os.path.join(W8, "mihomo.log"), "w"), stderr=subprocess.STDOUT)
    procs.append(p)
    return ports


def singbox_run(binary):
    ob = []
    for o in outs:
        o = json.loads(json.dumps(o))
        o["server"] = "127.0.0.1"
        tls = o.get("tls")
        if tls and not tls.get("reality"):
            tls["insecure"] = True
        ob.append(o)
    ports, inbounds, rules = {}, [], []
    for i, o in enumerate(ob):
        p = free_port()
        ports[o["tag"]] = p
        inbounds.append({"type": "mixed", "tag": f"in{i}", "listen": "127.0.0.1", "listen_port": p})
        rules.append({"inbound": [f"in{i}"], "outbound": o["tag"]})
    cfg = {"log": {"level": "warn"}, "inbounds": inbounds,
           "outbounds": ob + [{"type": "direct", "tag": "direct"}],
           "route": {"rules": rules, "final": "direct"}}
    path = os.path.join(W8, "sing-box.json")
    json.dump(cfg, open(path, "w"))
    p = subprocess.Popen([binary, "run", "-c", path],
                         stdout=open(os.path.join(W8, "sing-box.log"), "w"), stderr=subprocess.STDOUT)
    procs.append(p)
    return ports


def check_clients(label, ports):
    for name, port in ports.items():
        if not wait_listen(port):
            fail(f"{label}: listener for {name} did not come up (see {W8}/{label}.log)")
    bad = []
    for name, port in ports.items():
        ok = False
        for _ in range(5):
            if curl_via(port):
                ok = True
                break
            time.sleep(1)
        if not ok:
            bad.append(name)
    if bad:
        fail(f"{label}: no relay through {bad} (see {W8}/{label}.log)")
    print(f"{label}: {len(ports)} proxies relay through the agent")


clients = {}
mihomo = os.environ.get("MIHOMO_BIN") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "../../akari-client/bin/mihomo")
if os.access(mihomo, os.X_OK):
    clients["mihomo"] = mihomo_run(mihomo)
else:
    print("mihomo: not available (MIHOMO_BIN) — real-client check skipped")
singbox = os.environ.get("SINGBOX_BIN") or shutil.which("sing-box")
if singbox and os.access(singbox, os.X_OK):
    clients["sing-box"] = singbox_run(singbox)
else:
    print("sing-box: not available (SINGBOX_BIN) — real-client check skipped")
try:
    for label, ports in clients.items():
        check_clients(label, ports)

    # --- revocation through the panel: the user goes, new connections fail ---
    st, _ = api("DELETE", f"/api/v1/users/{USER}")
    if st != 204:
        fail(f"delete w8 user: {st}")
    time.sleep(1)
    deadline = time.time() + 20
    for label, ports in clients.items():
        for name, port in ports.items():
            while curl_via(port):
                if time.time() > deadline:
                    fail(f"{label}: {name} still relays after the user was deleted")
                time.sleep(1)
    if clients:
        print("revocation: every proxy refused after the user was deleted")
finally:
    for p in procs:
        p.terminate()
        try:
            p.wait(5)
        except subprocess.TimeoutExpired:
            p.kill()

st, _ = api("DELETE", f"/api/v1/users/{USER}")
st, r = api("PUT", f"/api/v1/nodes/{NODE_ID}/inbounds", {"inbounds": original})
if st != 200:
    fail(f"restore inbounds: {st} {r}")
print("w8 protocol matrix: ok")
