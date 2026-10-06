import { afterEach, describe, expect, it, vi } from 'vitest';
import { b64urlToBytes, bytesToB64url, creationOptions, credentialJSON, isUserCancel, requestOptions } from './webauthn';
import { authApi, passkeyApi } from './index';
import { leadingZeroBits, sha256Ascii, solvePow } from './pow';

const bytes = (...xs: number[]) => new Uint8Array(xs);

describe('base64url', () => {
  it('round-trips arbitrary bytes without padding', () => {
    const b = bytes(0, 255, 251, 62, 63, 1, 2);
    const s = bytesToB64url(b);
    expect(s).not.toMatch(/[+/=]/);
    expect([...b64urlToBytes(s)]).toEqual([...b]);
  });

  it('accepts the standard alphabet too (webauthn-rs is lenient, so is this)', () => {
    expect([...b64urlToBytes('+/8=')]).toEqual([251, 255]);
  });
});

describe('panel options → browser options', () => {
  it('decodes challenge, user id and excluded credentials for create()', () => {
    const o = creationOptions({
      challenge: 'AQID', rp: { id: 'akari.example', name: 'Akari' },
      user: { id: 'BAUG', name: 'a@b.c', displayName: 'a@b.c' },
      excludeCredentials: [{ type: 'public-key', id: 'BwgJ' }],
      authenticatorSelection: { residentKey: 'required' },
    });
    expect([...new Uint8Array(o.challenge as ArrayBuffer)]).toEqual([1, 2, 3]);
    expect([...new Uint8Array(o.user.id as ArrayBuffer)]).toEqual([4, 5, 6]);
    expect([...new Uint8Array(o.excludeCredentials![0].id as ArrayBuffer)]).toEqual([7, 8, 9]);
    expect(o.rp.id).toBe('akari.example');
  });

  it('decodes the challenge for get() and leaves an empty allow list alone', () => {
    const o = requestOptions({ challenge: 'AQID', userVerification: 'required' });
    expect([...new Uint8Array(o.challenge as ArrayBuffer)]).toEqual([1, 2, 3]);
    expect(o.allowCredentials).toBeUndefined();
  });
});

const assertion = {
  id: 'cred', type: 'public-key', rawId: bytes(1, 2).buffer,
  response: { clientDataJSON: bytes(3).buffer, authenticatorData: bytes(4).buffer, signature: bytes(5).buffer, userHandle: bytes(6).buffer },
  getClientExtensionResults: () => ({}),
} as unknown as PublicKeyCredential;

describe('browser credential → panel JSON', () => {
  it('encodes an assertion', () => {
    expect(credentialJSON(assertion)).toEqual({
      id: 'cred', rawId: 'AQI', type: 'public-key', extensions: {},
      response: { clientDataJSON: 'Aw', authenticatorData: 'BA', signature: 'BQ', userHandle: 'Bg' },
    });
  });

  it('encodes an attestation with its transports', () => {
    const att = {
      id: 'new', type: 'public-key', rawId: bytes(9).buffer,
      response: { clientDataJSON: bytes(3).buffer, attestationObject: bytes(8).buffer, getTransports: () => ['internal', 'hybrid'] },
      getClientExtensionResults: () => ({ credProps: { rk: true } }),
    } as unknown as PublicKeyCredential;
    expect(credentialJSON(att)).toEqual({
      id: 'new', rawId: 'CQ', type: 'public-key', extensions: { credProps: { rk: true } },
      response: { clientDataJSON: 'Aw', attestationObject: 'CA', transports: ['internal', 'hybrid'] },
    });
  });

  it('treats a dismissed system prompt as a cancel, not an error', () => {
    expect(isUserCancel(new DOMException('x', 'NotAllowedError'))).toBe(true);
    expect(isUserCancel(new Error('x'))).toBe(false);
  });
});

describe('passkey flows against the panel', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('signs in: options → navigator.credentials.get → login with the state token', async () => {
    const posts: { url: string; body: unknown }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      posts.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined });
      return url.endsWith('/options')
        ? new Response(JSON.stringify({ state: 'st', options: { publicKey: { challenge: 'AQID' } } }))
        : new Response(JSON.stringify({ id: 'u', email: 'a@b.c', role: 'user', expired: false, quota_exhausted: false }));
    }));
    const get = vi.fn(async () => assertion);
    vi.stubGlobal('navigator', { credentials: { get } });
    const r = await authApi.passkeyLogin();
    expect(r.email).toBe('a@b.c');
    expect(posts.map((p) => p.url)).toEqual(['/auth/passkey/options', '/auth/passkey/login']);
    expect(posts[1].body).toMatchObject({ state: 'st', credential: { rawId: 'AQI' } });
  });

  it('binds a passkey with the optional passkey-only flag', async () => {
    const posts: { url: string; body: unknown }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      posts.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined });
      return url.endsWith('/options')
        ? new Response(JSON.stringify({ state: 'rs', options: { publicKey: { challenge: 'AQID', user: { id: 'BAUG', name: 'a', displayName: 'a' } } } }))
        : new Response(JSON.stringify({ id: 'k1', name: 'Mac' }), { status: 201 });
    }));
    const att = { ...assertion, response: { clientDataJSON: bytes(3).buffer, attestationObject: bytes(8).buffer } };
    vi.stubGlobal('navigator', { credentials: { create: vi.fn(async () => att) } });
    await passkeyApi.add('Mac', true);
    expect(posts[1]).toMatchObject({ url: '/api/v1/me/passkeys', body: { state: 'rs', name: 'Mac', disable_password: true } });
  });
});

describe('registration proof of work', () => {
  it('hashes like SHA-256', () => {
    const hex = [...sha256Ascii('abc')].map((b) => b.toString(16).padStart(2, '0')).join('');
    expect(hex).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('finds a nonce with enough leading zero bits', async () => {
    const nonce = await solvePow('challenge-123', 10);
    expect(leadingZeroBits(sha256Ascii(`challenge-123:${nonce}`))).toBeGreaterThanOrEqual(10);
  });
});
