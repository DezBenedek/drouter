import { describe, it, expect, vi } from "vitest";
import { ReservationError, reservationFailure } from "../src/reservation";
import { SESSION_SECONDS, sessionSeconds } from "../src/relay";
import { remoteStatus } from "../../firmware/web/shared/client.js";
import { dictionaries } from "../../firmware/web/shared/i18n.js";

describe("remote registration and session lifetime", () => {
  it("distinguishes real name ownership conflicts from registry failures", async () => {
    const collision = reservationFailure(
      new ReservationError("name_unavailable"),
    );
    expect(collision.status).toBe(409);
    expect(await collision.json()).toEqual({ error: "name_unavailable" });
    const identity = reservationFailure(
      new ReservationError("invalid_identity"),
    );
    expect(identity.status).toBe(400);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const error of [
        new Error("SQLite unavailable"),
        new Error("name_unavailable"),
      ]) {
        const failure = reservationFailure(error);
        expect(failure.status).toBe(503);
        expect(await failure.json()).toEqual({ error: "registry_unavailable" });
      }
      expect(log).toHaveBeenCalledTimes(2);
    } finally {
      log.mockRestore();
    }
  });

  it("honors device expiry, caps it at 24 hours and supports older firmware", () => {
    expect(SESSION_SECONDS).toBe(86400);
    expect(sessionSeconds(86400)).toBe(86400);
    expect(sessionSeconds(1800)).toBe(1800);
    expect(sessionSeconds(7 * 86400)).toBe(86400);
    for (const invalid of [undefined, null, 0, -1, Infinity, NaN, "86400", 2.5])
      expect(sessionSeconds(invalid)).toBe(1800);
  });

  it("shows distinct, localized registration problems", () => {
    const states = [
      "name_unavailable",
      "registry_unavailable",
      "identity_in_use",
      "identity_rejected",
    ];
    expect(new Set(states.map(remoteStatus)).size).toBe(states.length);
    for (const state of states) {
      const text = remoteStatus(state) as keyof typeof dictionaries.en;
      expect(dictionaries.en[text]).toBe(text);
      expect(dictionaries.hu[text]).toBeTruthy();
      expect(dictionaries.hu[text]).not.toBe(text);
    }
  });
});
