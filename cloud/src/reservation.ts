export class ReservationError extends Error {
  constructor(public readonly code: "name_unavailable" | "invalid_identity") {
    super(code);
  }
}

export function reservationFailure(error: unknown): Response {
  if (error instanceof ReservationError)
    return Response.json(
      { error: error.code },
      { status: error.code === "name_unavailable" ? 409 : 400 },
    );
  console.error("Device registry reservation failed", error);
  return Response.json({ error: "registry_unavailable" }, { status: 503 });
}
