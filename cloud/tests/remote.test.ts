import { describe, it, expect, vi } from "vitest";
import { ReservationError, reservationFailure } from "../src/reservation";
import { SESSION_SECONDS, sessionSeconds } from "../src/relay";
import { Client, remoteStatus } from "../../firmware/web/shared/client.js";
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

describe("request scheduling", () => {
  it("prioritizes a switch over queued polling without overlapping exchanges", async () => {
    const client = new Client();
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let active = 0;
    client.request = async (op: string) => {
      expect(active++).toBe(0);
      started.push(op);
      if (started.length === 1) await gate;
      active--;
      return op;
    };
    const first = client.call("device.info");
    await Promise.resolve();
    const queued = [
      client.call("sources.list"),
      client.call("receivers.list"),
      client.call("route.set", { receiver: "one", source: "Camera A" }),
    ];
    release();
    await Promise.all([first, ...queued]);
    expect(started).toEqual([
      "device.info",
      "route.set",
      "sources.list",
      "receivers.list",
    ]);
  });
  it("keeps configuration mutations ordered and continues after a failed request", async () => {
    const client = new Client();
    const started: string[] = [];
    client.request = async (op: string) => {
      started.push(op);
      if (op === "settings.update") throw new Error("Rejected change");
      return op;
    };
    const failed = expect(client.call("settings.update")).rejects.toThrow(
      "Rejected change",
    );
    await Promise.all([
      failed,
      client.call("sources.list"),
      client.call("route.set"),
    ]);
    expect(started).toEqual(["settings.update", "route.set", "sources.list"]);
    expect(await client.call("device.info")).toBe("device.info");
  });
});

describe("tab session restoration", () => {
  function storage() {
    const values = new Map<string, string>();
    const result = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
    };
    vi.stubGlobal("sessionStorage", result);
    return result;
  }
  const saved = () => ({
    remote: true,
    origin: "https://router.test",
    name: "studio",
    ticket: "ab".repeat(16),
    secret: "cd".repeat(32),
    expiresAt: Date.now() + 3600000,
  });
  it("discards expired credentials before opening a connection", async () => {
    const store = storage();
    store.setItem(
      "drouter-session-v1",
      JSON.stringify({ ...saved(), expiresAt: Date.now() - 1 }),
    );
    const connect = vi.spyOn(Client.prototype, "transport");
    try {
      expect(
        await Client.restore({ origin: "https://router.test" }),
      ).toBeNull();
      expect(connect).not.toHaveBeenCalled();
      expect(store.getItem("drouter-session-v1")).toBeNull();
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });
  it("rejects a forged device challenge without sending a proof or secret", async () => {
    const store = storage();
    store.setItem("drouter-session-v1", JSON.stringify(saved()));
    vi.spyOn(Client.prototype, "transport").mockResolvedValue(undefined);
    const exchange = vi.spyOn(Client.prototype, "exchange").mockResolvedValue({
      type: "auth.resume.challenge",
      nonce: "ef".repeat(32),
      proof: "00".repeat(32),
    });
    try {
      expect(
        await Client.restore({ origin: "https://router.test" }),
      ).toBeNull();
      expect(exchange).toHaveBeenCalledTimes(1);
      expect(exchange).toHaveBeenCalledWith({
        type: "auth.resume.start",
        ticket: saved().ticket,
      });
      expect(store.getItem("drouter-session-v1")).toBeNull();
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });
  it("clears storage immediately and sends a valid ordered logout after pending work", async () => {
    const store = storage();
    store.setItem("drouter-session-v1", JSON.stringify(saved()));
    const client = new Client();
    client.resumeId = saved().ticket;
    client.key = new Uint8Array(32).fill(1);
    let release!: () => void;
    client.inFlight = new Promise<void>((resolve) => {
      release = resolve;
    });
    const request = vi
      .spyOn(client, "request")
      .mockResolvedValue({ logout: true });
    try {
      client.close();
      expect(store.getItem("drouter-session-v1")).toBeNull();
      expect(request).not.toHaveBeenCalled();
      release();
      await vi.waitFor(() =>
        expect(request).toHaveBeenCalledWith("auth.logout", {}),
      );
      await vi.waitFor(() => expect(client.key).toBeNull());
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });
});
