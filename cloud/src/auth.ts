export const remoteName = /^(?=.{3,32}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;
export function unhex(s: string): Uint8Array<ArrayBuffer> {
  if (!/^(?:[a-f0-9]{2})+$/i.test(s)) throw new Error("Invalid encoding");
  return Uint8Array.from(s.match(/../g)!, (x) => parseInt(x, 16));
}
export function hex(b: ArrayBuffer | Uint8Array): string {
  return Array.from(new Uint8Array(b as ArrayBuffer), (n) =>
    n.toString(16).padStart(2, "0"),
  ).join("");
}
export async function identityId(publicKey: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", unhex(publicKey)));
}
export async function verifyRegistration(
  deviceId: string,
  nonce: string,
  m: Record<string, unknown>,
): Promise<boolean> {
  try {
    if (
      typeof m.name !== "string" ||
      !remoteName.test(m.name) ||
      m.deviceId !== deviceId ||
      typeof m.publicKey !== "string" ||
      m.publicKey.length !== 64 ||
      typeof m.signature !== "string" ||
      m.signature.length !== 128 ||
      deviceId !== (await identityId(m.publicKey))
    )
      return false;
    const key = await crypto.subtle.importKey(
      "raw",
      unhex(m.publicKey),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      "Ed25519",
      key,
      unhex(m.signature),
      new TextEncoder().encode(
        `drouter-register-v2\n${deviceId}\n${m.name}\n${nonce}`,
      ),
    );
  } catch {
    return false;
  }
}
