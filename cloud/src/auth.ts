export const remoteName = /^[a-z0-9](?:[a-z0-9-]{1,30})[a-z0-9]--[a-f0-9]{32}$/;
export function unhex(s: string): Uint8Array<ArrayBuffer> {
  if (!/^(?:[a-f0-9]{2})+$/i.test(s)) throw new Error("Invalid encoding");
  return Uint8Array.from(s.match(/../g)!, (x) => parseInt(x, 16));
}
export function hex(b: ArrayBuffer | Uint8Array): string {
  return Array.from(new Uint8Array(b as ArrayBuffer), (n) =>
    n.toString(16).padStart(2, "0"),
  ).join("");
}
export async function verifyRegistration(
  name: string,
  nonce: string,
  m: Record<string, unknown>,
): Promise<boolean> {
  try {
    if (
      !remoteName.test(name) ||
      m.name !== name ||
      typeof m.publicKey !== "string" ||
      m.publicKey.length !== 64 ||
      typeof m.signature !== "string" ||
      m.signature.length !== 128
    )
      return false;
    const pub = unhex(m.publicKey);
    const fingerprint = hex(await crypto.subtle.digest("SHA-256", pub)).slice(
      0,
      32,
    );
    if (!name.endsWith(`--${fingerprint}`)) return false;
    const key = await crypto.subtle.importKey(
      "raw",
      pub,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      "Ed25519",
      key,
      unhex(m.signature),
      new TextEncoder().encode(`drouter-register-v1\n${name}\n${nonce}`),
    );
  } catch {
    return false;
  }
}
