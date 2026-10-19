export const MAX_MESSAGE = 32768;
export const SESSION_SECONDS = 24 * 60 * 60;
// Respect older firmware's shorter session too. Never extend its authorization.
export function sessionSeconds(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? Math.min(value, SESSION_SECONDS)
    : 1800;
}
export type Frame = { type: string; [key: string]: unknown };
export function parseFrame(message: string | ArrayBuffer): Frame {
  if (
    typeof message !== "string" ||
    new TextEncoder().encode(message).length > MAX_MESSAGE
  )
    throw new Error("Invalid frame");
  const value = JSON.parse(message);
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof value.type !== "string"
  )
    throw new Error("Invalid frame");
  return value;
}
export function validClientFrame(frame: Frame, stage: string): boolean {
  if (stage === "new")
    return (
      frame.type === "auth.start" &&
      typeof frame.a === "string" &&
      /^[a-f0-9]{2,512}$/i.test(frame.a)
    );
  if (stage === "challenge" || stage === "fake")
    return (
      frame.type === "auth.proof" &&
      typeof frame.proof === "string" &&
      (frame.proofs === undefined ||
        (Array.isArray(frame.proofs) &&
          frame.proofs.length <= 9 &&
          frame.proofs.every(
            (p) => typeof p === "string" && /^[a-f0-9]{64}$/i.test(p),
          ))) &&
      /^[a-f0-9]{64}$/i.test(frame.proof)
    );
  return (
    stage === "authorized" &&
    frame.type === "rpc" &&
    Number.isSafeInteger(frame.seq) &&
    typeof frame.data === "string" &&
    frame.data.length <= 30000 &&
    /^[a-f0-9]+$/i.test(frame.data)
  );
}
