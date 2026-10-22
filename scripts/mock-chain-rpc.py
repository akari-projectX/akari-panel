# A mock EVM JSON-RPC node for the USDT on-chain payment method (C2):
# eth_chainId (137) / blockNumber / call (decimals 6) / getLogs / getTransactionReceipt /
# getBlockByNumber over the transfers the tests add. POST /control/pay?to=&units= mines a
# block with a Transfer of the Polygon USDT to `to`; POST /control/mine?n= mines n blocks.
#   python3 scripts/mock-chain-rpc.py <port>   (smoke.sh, scripts/e2e-portal.sh)
import json, sys, time, urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
TOKEN = "0xc2132d05d31c914a87c6611c10748aeb04b58e8f"
TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
# Block times: the genesis stretch is 1 s per block up to the start; every block mined later
# carries the wall clock of its mining (the panel matches a transfer to an order only when the
# block time falls inside the order's window, so a node started long before the test must not
# hand out times from its start).
S = {"head": 1000, "logs": [], "t0": int(time.time()) - 1000, "n": 0, "times": {}}
def mined(n):
    now = int(time.time())
    for b in range(S["head"] + 1, S["head"] + n + 1): S["times"][b] = now
    S["head"] += n
def topic(a): return "0x" + "0" * 24 + a[2:].lower()
def bhash(n): return "0x%064x" % (n << 8)
def log(l): return {"address": TOKEN, "topics": [TRANSFER, topic("0x" + "3" * 40), topic(l["to"])],
    "data": "0x%064x" % l["units"], "blockNumber": hex(l["block"]), "blockHash": bhash(l["block"]),
    "transactionHash": l["tx"], "logIndex": "0x0", "removed": False}
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def answer(self, obj):
        b = json.dumps(obj).encode(); self.send_response(200)
        self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(b)))
        self.end_headers(); self.wfile.write(b)
    def do_POST(self):
        u = urllib.parse.urlparse(self.path); q = dict(urllib.parse.parse_qsl(u.query))
        raw = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        if u.path == "/control/pay":
            mined(1); S["n"] += 1
            tx = "0x%064x" % (0x5a0000 + S["n"])
            S["logs"].append({"to": q["to"].lower(), "units": int(q["units"]), "block": S["head"], "tx": tx})
            return self.answer({"tx": tx})
        if u.path == "/control/mine":
            mined(int(q["n"])); return self.answer({"head": S["head"]})
        r = json.loads(raw); m = r["method"]; p = r.get("params", [])
        if m == "eth_chainId": res = hex(137)
        elif m == "eth_blockNumber": res = hex(S["head"])
        elif m == "eth_call": res = "0x%064x" % 6
        elif m == "eth_getLogs":
            f = p[0]; lo, hi = int(f["fromBlock"], 16), int(f["toBlock"], 16)
            res = [log(l) for l in S["logs"] if lo <= l["block"] <= min(hi, S["head"])
                   and f["address"].lower() == TOKEN and topic(l["to"]) == f["topics"][2]]
        elif m == "eth_getTransactionReceipt":
            mine = [l for l in S["logs"] if l["tx"] == p[0]]
            res = None if not mine else {"status": "0x1", "blockNumber": hex(mine[0]["block"]),
                "blockHash": bhash(mine[0]["block"]), "logs": [log(l) for l in mine]}
        elif m == "eth_getBlockByNumber":
            n = int(p[0], 16)
            res = None if n > S["head"] else {"number": hex(n), "hash": bhash(n), "timestamp": hex(S["times"].get(n, S["t0"] + n))}
        else:
            return self.answer({"jsonrpc": "2.0", "id": r["id"], "error": {"code": -32601, "message": "no"}})
        self.answer({"jsonrpc": "2.0", "id": r["id"], "result": res})
ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
