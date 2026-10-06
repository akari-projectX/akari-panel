#!/usr/bin/env python3
"""W8 protocol matrix smoke (called by smoke.sh with the agent running).

For every inbound template, one after the other (W28-a/D2: a node has one
inbound): render it through the panel API, put it on the smoke node
(127.0.0.1, a throwaway self-signed certificate in place of the node's
certificate files, a local TLS 1.3 site as the REALITY target) and check
  - the agent applies it (no last_error, a fresh "state applied"),
  - the plan-granted user's credential fits the protocol,
  - the three subscription formats carry a correct entry (and leave out
    what a format cannot express: xhttp in sing-box),
  - with real clients when available (mihomo: MIHOMO_BIN or
    ../akari-client/bin/mihomo; sing-box: SINGBOX_BIN), the proxy of the
    rendered subscription relays HTTP through the agent.
Deleting the user then cuts new connections (gate + validator). The node's
previous inbound is restored at the end.

Env: BASE, SUB_PATH (the site-wide subscription path), JAR, NODE_ID, ACCESS_PLAN (a plan granting the node's direct
entrance), LOG (smoke log dir), AGENT_LOG, VALKEY_DB (smoke's Valkey db:
the subscription rate limit is reset between templates).
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
ACCESS_PLAN = os.environ["ACCESS_PLAN"]
VALKEY_DB = os.environ["VALKEY_DB"]
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


# D4/D11: BASE is under the admin prefix; subscriptions are at
# /<SUB_PATH>/<token> on the panel's root.
SUB_BASE = BASE.rsplit("/", 1)[0] + "/" + os.environ["SUB_PATH"]


def api(method, path, body=None, ua=None, raw=False):
    req = urllib.request.Request(path if path.startswith("http") else BASE + path, method=method)
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

# --- one template at a time ----------------------------------------------------

st, node = api("GET", f"/api/v1/nodes/{NODE_ID}")
original = node["inbound"]

real = {"dest": DEST, "server_name": DOMAIN}
T = [  # (label, expected protocol, template spec without port)
    ("w8-reality-vision", "vless", dict(template="vless_reality", **real)),
    ("w8-reality-xhttp", "vless", dict(template="vless_reality_xhttp", path="/rx", **real)),
    ("w8-tls-vision", "vless", dict(template="vless_tls_vision", domain=DOMAIN)),
    ("w8-vless-ws-tls", "vless", dict(template="vless_ws_tls", domain=DOMAIN)),
    ("w8-vless-hu", "vless", dict(template="transport", protocol="vless", network="httpupgrade")),
    ("w8-vless-hu-tls", "vless", dict(template="transport", protocol="vless", network="httpupgrade", tls_domain=DOMAIN)),
    ("w8-vless-xhttp", "vless", dict(template="transport", protocol="vless", network="xhttp")),
    ("w8-vless-xhttp-tls", "vless", dict(template="transport", protocol="vless", network="xhttp", tls_domain=DOMAIN)),
    ("w8-vless-grpc", "vless", dict(template="transport", protocol="vless", network="grpc", tls_domain=DOMAIN, service_name="w8svc")),
    ("w8-vmess-tcp", "vmess", dict(template="vmess_tcp")),
    ("w8-vmess-ws", "vmess", dict(template="vmess_ws")),
    ("w8-vmess-grpc", "vmess", dict(template="transport", protocol="vmess", network="grpc", tls_domain=DOMAIN)),
    ("w8-trojan-tls", "trojan", dict(template="trojan_tls", domain=DOMAIN)),
    ("w8-trojan-ws", "trojan", dict(template="transport", protocol="trojan", network="ws", tls_domain=DOMAIN)),
    ("w8-trojan-grpc", "trojan", dict(template="transport", protocol="trojan", network="grpc", tls_domain=DOMAIN)),
    ("w8-ss128", "shadowsocks", dict(template="shadowsocks_2022")),
    ("w8-ss256", "shadowsocks", dict(template="shadowsocks_2022", method="2022-blake3-aes-256-gcm")),
    ("w8-hy2", "hysteria", dict(template="hysteria2", domain=DOMAIN)),
]
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
vmess_nets = {"w8-vmess-tcp": "tcp", "w8-vmess-ws": "ws", "w8-vmess-grpc": "grpc"}

st, u = api("POST", "/api/v1/users", {"email": "w8-user@smoke.test", "password": "user-password-123"})
if st != 201:
    fail(f"create w8 user: {st} {u}")
USER, SUB = u["id"], f"{SUB_BASE}/{u['sub_token']}"
# D3: access comes from the plan (it grants the node's direct entrance).
st, r = api("PUT", f"/api/v1/users/{USER}/plan", {"plan_id": ACCESS_PLAN, "period": "month"})
if st != 200:
    fail(f"w8 user plan: {st} {r}")


def render(label, spec):
    st, r = api("POST", "/api/v1/inbound-templates/render", {"template": dict(spec, port=free_port())})
    if st != 200:
        fail(f"render {label}: {st} {r}")
    inb = r["inbound"]
    if "tag" in inb:
        fail(f"{label}: a rendered inbound carries a tag (the panel names it)")
    inb["listen"] = "127.0.0.1"
    certs = inb.get("streamSettings", {}).get("tlsSettings", {}).get("certificates", [])
    if certs and not r["needs_certificate"]:
        fail(f"{label}: reads the node certificate but needs_certificate is false")
    for c in certs:
        if c.get("certificateFile") != CERT_FILE or c.get("keyFile") != KEY_FILE:
            fail(f"{label}: template does not read the node certificate files")
        c["certificateFile"] = f"{W8}/fullchain.pem"
        c["keyFile"] = f"{W8}/privkey.pem"
    return inb


def apply(label, inb):
    before = open(AGENT_LOG).read().count('"msg":"state applied"')
    st, r = api("PUT", f"/api/v1/nodes/{NODE_ID}/inbound", {"inbound": inb})
    if st != 200:
        fail(f"put {label}: {st} {r}")
    deadline = time.time() + 30
    while time.time() < deadline:
        st, n = api("GET", f"/api/v1/nodes/{NODE_ID}")
        applied = open(AGENT_LOG).read().count('"msg":"state applied"')
        # (W18: the "run 重装命令 once" updater warning is about the agent
        # build, not the inbound: an agent main without the updater shows it.)
        warnings = [w for w in n["warnings"] if "akari-agent-update" not in w]
        if n["last_error"] is None and applied > before and not warnings:
            if inb["protocol"] == "hysteria":
                return
            s = socket.socket()
            s.settimeout(1)
            try:
                s.connect(("127.0.0.1", inb["port"]))
                return
            except OSError:
                pass
            finally:
                s.close()
        time.sleep(0.5)
    fail(f"agent did not apply {label} (last_error={n['last_error']}, warnings={n['warnings']})")


def check_link(label, proto, spec, inb):
    reset_sub_limit()
    st, body = api("GET", SUB, ua="v2rayN/7.0", raw=True)
    links = base64.b64decode(body.strip()).decode().splitlines()
    if len(links) != 1:
        fail(f"links for {label}: {links}")
    line = links[0]
    for p in expect_links.get(label, []):
        if p not in line:
            fail(f"links: {label} lacks {p!r}: {line}")
    if label in vmess_nets:
        v = json.loads(base64.b64decode(line[8:]))
        if v["net"] != vmess_nets[label] or v["aid"] != "0" or v["scy"] != "auto":
            fail(f"links: vmess {label}: {v}")
    # The user's credential fits the protocol (D3: the plan generated it).
    want_flow = "xtls-rprx-vision" if spec["template"] in ("vless_reality", "vless_tls_vision") else ""
    if proto == "vless" and ("flow=xtls-rprx-vision" in line) != bool(want_flow):
        fail(f"{label}: flow in {line}, want {want_flow!r}")
    if proto == "shadowsocks":
        method, pw = line.split("@")[0][len("ss://"):].split(":", 1)
        psk, key = urllib.request.unquote(pw).split(":")
        if psk != inb["settings"]["password"]:
            fail(f"links: {label} server PSK mismatch")
        n = 32 if "256" in method else 16
        if len(base64.b64decode(key)) != n:
            fail(f"{label}: user key is not {n} bytes")
    if proto == "hysteria" and len(line[len("hysteria2://"):].split("@")[0]) != 64:
        fail(f"{label}: hysteria auth missing")


clash_all = ""
sb_outs = []


def reset_sub_limit():
    # Three formats per template, 18 templates: past smoke's per-token
    # subscription limit (8 per window). Clear its buckets.
    subprocess.run(
        ["docker", "compose", "exec", "-T", "valkey", "valkey-cli", "-n", VALKEY_DB, "EVAL",
         "for _,k in ipairs(redis.call('KEYS', ARGV[1])) do redis.call('DEL', k) end return 1",
         "0", "akari:rl:sub:*"],
        check=True, capture_output=True)



def subscriptions(label, inb):
    global clash_all
    st, clash = api("GET", SUB, ua="clash.meta/1.19", raw=True)
    clash = clash.decode()
    if clash.count("\n  - name: ") + clash.startswith("  - name: ") - 1 != 1:  # minus the group
        fail(f"clash: not one proxy for {label}")
    clash_all += clash
    st, sb = api("GET", SUB, ua="sing-box/1.12.0")
    # W30: the profile also carries the PROXY selector and direct.
    outs = [o for o in sb["outbounds"] if o["type"] not in ("direct", "selector")]
    xhttp = inb.get("streamSettings", {}).get("network") == "xhttp"
    if len(outs) != (0 if xhttp else 1):
        fail(f"sing-box: {len(outs)} outbounds for {label} (xhttp left out)")
    sb_outs.extend(outs)
    return clash, outs


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


def mihomo_run(binary, clash, label):
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
                         stdout=open(os.path.join(W8, f"mihomo-{label}.log"), "w"), stderr=subprocess.STDOUT)
    procs.append(p)
    return ports


def singbox_run(binary, outs, label):
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
                         stdout=open(os.path.join(W8, f"sing-box-{label}.log"), "w"), stderr=subprocess.STDOUT)
    procs.append(p)
    return ports


def check_clients(client, label, ports):
    for name, port in ports.items():
        if not wait_listen(port):
            fail(f"{client}: listener for {label} did not come up (see {W8}/{client}-{label}.log)")
    for name, port in ports.items():
        for _ in range(5):
            if curl_via(port):
                break
            time.sleep(1)
        else:
            fail(f"{client}: no relay through {label} (see {W8}/{client}-{label}.log)")


def stop_clients():
    for p in procs:
        p.terminate()
        try:
            p.wait(5)
        except subprocess.TimeoutExpired:
            p.kill()
    procs.clear()


mihomo = os.environ.get("MIHOMO_BIN") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "../../akari-client/bin/mihomo")
if not os.access(mihomo, os.X_OK):
    mihomo = None
    print("mihomo: not available (MIHOMO_BIN) — real-client check skipped")
singbox = os.environ.get("SINGBOX_BIN") or shutil.which("sing-box")
if not (singbox and os.access(singbox, os.X_OK)):
    singbox = None
    print("sing-box: not available (SINGBOX_BIN) — real-client check skipped")

relayed = {"mihomo": 0, "sing-box": 0}
last_ports = {}
try:
    for i, (label, proto, spec) in enumerate(T):
        inb = render(label, spec)
        if inb["protocol"] != proto:
            fail(f"{label}: rendered protocol {inb['protocol']} != {proto}")
        apply(label, inb)
        check_link(label, proto, spec, inb)
        clash, outs = subscriptions(label, inb)
        last = i == len(T) - 1
        clients = {}
        if mihomo:
            clients["mihomo"] = mihomo_run(mihomo, clash, label)
        if singbox and outs:
            clients["sing-box"] = singbox_run(singbox, outs, label)
        for client, ports in clients.items():
            check_clients(client, label, ports)
            relayed[client] += len(ports)
        if last:
            last_ports = clients
        else:
            stop_clients()
    print(f"agent applied {len(T)} template inbounds one after the other")

    for want in ("type: ss\n", "cipher: 2022-blake3-aes-256-gcm", "type: hysteria2\n", "network: xhttp\n",
                 "v2ray-http-upgrade: true", "grpc-service-name: w8svc", "flow: xtls-rprx-vision"):
        if want not in clash_all:
            fail(f"clash lacks {want!r}")
    types = {o["type"] for o in sb_outs}
    for t in ("vless", "vmess", "trojan", "shadowsocks", "hysteria2"):
        if t not in types:
            fail(f"sing-box lacks {t}")
    if not any(o.get("transport", {}).get("type") == "httpupgrade" for o in sb_outs):
        fail("sing-box lacks the httpupgrade transport")
    if not any(o.get("transport", {}).get("type") == "grpc" for o in sb_outs):
        fail("sing-box lacks the grpc transport")
    print("subscriptions: links/clash/sing-box carry the matrix")
    for client, n in relayed.items():
        if n:
            print(f"{client}: {n} proxies relayed through the agent")

    # --- revocation through the panel: the user goes, new connections fail ---
    st, _ = api("DELETE", f"/api/v1/users/{USER}?confirm=true")
    if st != 204:
        fail(f"delete w8 user: {st}")
    time.sleep(1)
    deadline = time.time() + 20
    for client, ports in last_ports.items():
        for name, port in ports.items():
            while curl_via(port):
                if time.time() > deadline:
                    fail(f"{client}: {name} still relays after the user was deleted")
                time.sleep(1)
    if last_ports:
        print("revocation: the proxy is refused after the user was deleted")
finally:
    stop_clients()

st, _ = api("DELETE", f"/api/v1/users/{USER}?confirm=true")
st, r = api("PUT", f"/api/v1/nodes/{NODE_ID}/inbound", {"inbound": original})
if st != 200:
    fail(f"restore inbound: {st} {r}")
print("w8 protocol matrix: ok")
