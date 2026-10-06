// WebAuthn JSON <-> browser objects (W27 passkeys). The panel (webauthn-rs)
// sends `{publicKey: …}` options with base64url binary fields and expects
// the credential back as JSON with base64url fields.
const b64uToBuf = (s: string): ArrayBuffer => {
  const b64 = s
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(s.length / 4) * 4, "=");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
};

const bufToB64u = (b: ArrayBuffer | null | undefined): string | undefined => {
  if (!b) return undefined;
  const bytes = new Uint8Array(b);
  let bin = "";
  for (const x of bytes) bin += String.fromCharCode(x);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

type Json = Record<string, unknown>;

export function passkeysSupported(): boolean {
  return typeof window.PublicKeyCredential === "function" && !!navigator.credentials;
}

/** Run a discoverable login with the server's options; the credential JSON to post back. */
export async function getAssertion(options: Json): Promise<Json> {
  const pk = { ...(options.publicKey as Json) };
  pk.challenge = b64uToBuf(pk.challenge as string);
  if (Array.isArray(pk.allowCredentials))
    pk.allowCredentials = (pk.allowCredentials as Json[]).map((c) => ({ ...c, id: b64uToBuf(c.id as string) }));
  const cred = (await navigator.credentials.get({
    publicKey: pk as unknown as PublicKeyCredentialRequestOptions,
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error("no credential");
  const r = cred.response as AuthenticatorAssertionResponse;
  return {
    id: cred.id,
    rawId: bufToB64u(cred.rawId),
    type: cred.type,
    extensions: {},
    response: {
      authenticatorData: bufToB64u(r.authenticatorData),
      clientDataJSON: bufToB64u(r.clientDataJSON),
      signature: bufToB64u(r.signature),
      userHandle: bufToB64u(r.userHandle),
    },
  };
}

/** Create a passkey with the server's registration options; the credential JSON. */
export async function createCredential(options: Json): Promise<Json> {
  const pk = { ...(options.publicKey as Json) };
  pk.challenge = b64uToBuf(pk.challenge as string);
  const user = { ...(pk.user as Json) };
  user.id = b64uToBuf(user.id as string);
  pk.user = user;
  if (Array.isArray(pk.excludeCredentials))
    pk.excludeCredentials = (pk.excludeCredentials as Json[]).map((c) => ({ ...c, id: b64uToBuf(c.id as string) }));
  const cred = (await navigator.credentials.create({
    publicKey: pk as unknown as PublicKeyCredentialCreationOptions,
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error("no credential");
  const r = cred.response as AuthenticatorAttestationResponse;
  return {
    id: cred.id,
    rawId: bufToB64u(cred.rawId),
    type: cred.type,
    extensions: {},
    response: {
      attestationObject: bufToB64u(r.attestationObject),
      clientDataJSON: bufToB64u(r.clientDataJSON),
      transports: typeof r.getTransports === "function" ? r.getTransports() : undefined,
    },
  };
}
