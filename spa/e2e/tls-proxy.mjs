#!/usr/bin/env node
/*
 * 端到端测试用的 TLS 反代（代替生产环境的 Caddy）：浏览器经 https 访问门户，主域名是 https 源，
 * 通行密钥（WebAuthn 只在安全上下文、且 RP 是主域名时可用）才能真正走通。
 *
 *   node e2e/tls-proxy.mjs <证书> <私钥> <监听端口> <面板 http 地址>
 *
 * 每个客户端连接给一个随机的 X-Forwarded-For（面板把 127.0.0.1 当受信反代）：所有用例都从 127.0.0.1 来，
 * 不这样做的话按地址的限速（注册每小时 5 次……）会让后面的用例失败。只给测试用，不是部署方式。
 */
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:https';

const [cert, key, port, upstream] = process.argv.slice(2);
const up = new URL(upstream);
const peers = new WeakMap();
const ip = () => `198.18.${Math.floor(Math.random() * 256)}.${1 + Math.floor(Math.random() * 254)}`;

const server = createServer({ cert: readFileSync(cert), key: readFileSync(key) }, (req, res) => {
  if (!peers.has(req.socket)) peers.set(req.socket, ip());
  const p = request(
    {
      host: up.hostname, port: up.port, method: req.method, path: req.url,
      headers: { ...req.headers, 'x-forwarded-for': peers.get(req.socket), 'x-forwarded-proto': 'https' },
    },
    (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    },
  );
  p.on('error', () => { res.writeHead(502); res.end(); });
  req.pipe(p);
});
server.listen(Number(port), '127.0.0.1');
