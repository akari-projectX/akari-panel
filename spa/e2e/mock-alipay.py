# 端到端测试用的支付宝当面付模拟网关（移植自面板 smoke.sh，只用临时生成的密钥）。
#   python3 e2e/mock-alipay.py <密钥目录> <端口>
# 校验面板的请求签名（应用公钥），用「支付宝」私钥签名答复；POST /control/pay?otn=X 把交易标成已付款（查单时返回 TRADE_SUCCESS）；
# 原路退款（alipay.trade.refund）按请求号幂等记账，退款查询照实回答。
import base64, json, subprocess, sys, urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
D = sys.argv[1]; trades = {}; refunds = {}
def sign(data):
    return base64.b64encode(subprocess.run(["openssl", "dgst", "-sha256", "-sign", D + "/alipay-key.pem"],
        input=data.encode(), capture_output=True, check=True).stdout).decode()
def verify(data, sig):
    open(D + "/req.sig", "wb").write(base64.b64decode(sig))
    return subprocess.run(["openssl", "dgst", "-sha256", "-verify", D + "/app-pub.pem", "-signature", D + "/req.sig"],
        input=data.encode(), capture_output=True).returncode == 0
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def answer(self, code, body):
        b = body.encode(); self.send_response(code)
        self.send_header("Content-Type", "application/json;charset=utf-8"); self.send_header("Content-Length", str(len(b)))
        self.end_headers(); self.wfile.write(b)
    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        raw = self.rfile.read(int(self.headers.get("Content-Length", 0))).decode()
        if u.path == "/control/pay":
            otn = urllib.parse.parse_qs(u.query)["otn"][0]; trades[otn]["status"] = "TRADE_SUCCESS"
            return self.answer(200, "{}")
        p = dict(urllib.parse.parse_qsl(raw, keep_blank_values=True))
        content = "&".join(f"{k}={v}" for k, v in sorted(p.items()) if k != "sign" and v != "")
        if not verify(content, p["sign"]): return self.answer(400, '{"error":"bad request signature"}')
        m = p["method"]; biz = json.loads(p["biz_content"]); otn = biz["out_trade_no"]
        if m == "alipay.trade.precreate":
            trades[otn] = {"total": biz["total_amount"], "status": None}
            obj = {"code": "10000", "msg": "Success", "out_trade_no": otn, "qr_code": "https://qr.alipay.com/smoke" + otn[-6:]}
        elif m == "alipay.trade.query" and trades.get(otn, {}).get("status"):
            t = trades[otn]
            obj = {"code": "10000", "msg": "Success", "out_trade_no": otn, "trade_no": "2026" + otn[-10:],
                   "trade_status": t["status"], "total_amount": t["total"]}
        elif m == "alipay.trade.refund" and otn in trades:
            refunds.setdefault(biz["out_request_no"], (otn, biz["refund_amount"]))
            obj = {"code": "10000", "msg": "Success", "out_trade_no": otn, "trade_no": "2026" + otn[-10:],
                   "refund_fee": refunds[biz["out_request_no"]][1], "fund_change": "Y"}
        elif m == "alipay.trade.fastpay.refund.query":
            r = refunds.get(biz["out_request_no"])
            obj = {"code": "10000", "msg": "Success", "out_trade_no": otn}
            if r: obj.update({"out_request_no": biz["out_request_no"], "refund_amount": r[1]})
        else:
            obj = {"code": "40004", "msg": "Business Failed", "sub_code": "ACQ.TRADE_NOT_EXIST", "sub_msg": "x"}
        body = json.dumps(obj, separators=(",", ":"))
        self.answer(200, '{"%s_response":%s,"sign":"%s"}' % (m.replace(".", "_"), body, sign(body)))
ThreadingHTTPServer(("127.0.0.1", int(sys.argv[2])), H).serve_forever()
