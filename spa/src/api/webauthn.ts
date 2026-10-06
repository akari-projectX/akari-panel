/**
 * WebAuthn（通行密钥）与面板之间的 JSON 编解码。
 *
 * 面板（webauthn-rs）给的 options 是 `{ publicKey: {...} }`，其中 challenge、user.id、
 * excludeCredentials[].id、allowCredentials[].id 是 base64url 字符串；浏览器要的是 ArrayBuffer。
 * 浏览器返回的 PublicKeyCredential 里全是 ArrayBuffer；面板要的是 base64url 字符串的 JSON。
 * 两个方向都在这里转，登录与绑定共用。
 */

export function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=');
  const bin = atob(pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64url(buf: ArrayBuffer | ArrayBufferView): string {
  const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

type Json = Record<string, unknown>;

const withIds = (list: unknown): unknown =>
  Array.isArray(list)
    ? list.map((c: Json) => ({ ...c, id: b64urlToBytes(String(c.id)) }))
    : list;

/** 面板的注册挑战 → navigator.credentials.create 的参数 */
export function creationOptions(publicKey: Json): PublicKeyCredentialCreationOptions {
  const user = publicKey.user as Json;
  return {
    ...publicKey,
    challenge: b64urlToBytes(String(publicKey.challenge)),
    user: { ...user, id: b64urlToBytes(String(user.id)) },
    excludeCredentials: withIds(publicKey.excludeCredentials),
  } as unknown as PublicKeyCredentialCreationOptions;
}

/** 面板的登录挑战 → navigator.credentials.get 的参数 */
export function requestOptions(publicKey: Json): PublicKeyCredentialRequestOptions {
  return {
    ...publicKey,
    challenge: b64urlToBytes(String(publicKey.challenge)),
    allowCredentials: withIds(publicKey.allowCredentials),
  } as unknown as PublicKeyCredentialRequestOptions;
}

const enc = (v: ArrayBuffer | null | undefined) => (v ? bytesToB64url(v) : undefined);

/** 浏览器给的凭据 → 面板要的 JSON（登录与注册两种响应都认） */
export function credentialJSON(cred: PublicKeyCredential): Json {
  const r = cred.response as AuthenticatorResponse & {
    attestationObject?: ArrayBuffer;
    authenticatorData?: ArrayBuffer;
    signature?: ArrayBuffer;
    userHandle?: ArrayBuffer | null;
    getTransports?: () => string[];
  };
  const response: Json = { clientDataJSON: bytesToB64url(r.clientDataJSON) };
  if (r.attestationObject) {
    response.attestationObject = enc(r.attestationObject);
    const transports = r.getTransports?.();
    if (transports?.length) response.transports = transports;
  } else {
    response.authenticatorData = enc(r.authenticatorData);
    response.signature = enc(r.signature);
    if (r.userHandle) response.userHandle = enc(r.userHandle);
  }
  return {
    id: cred.id,
    rawId: bytesToB64url(cred.rawId),
    type: cred.type,
    response,
    extensions: cred.getClientExtensionResults?.() ?? {},
  };
}

/** 这个浏览器能不能用通行密钥 */
export function webauthnSupported(): boolean {
  return typeof window !== 'undefined' && typeof window.PublicKeyCredential === 'function'
    && !!navigator.credentials;
}

/** 用户在系统弹窗里取消、超时：不算错误，不弹提示 */
export function isUserCancel(e: unknown): boolean {
  return e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'AbortError');
}
