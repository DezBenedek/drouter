import { describe, it, expect } from "vitest";
import { parseFrame, validClientFrame, MAX_MESSAGE } from "../src/relay";
import { remoteName, verifyRegistration } from "../src/auth";
import { operations } from "../src/operations";
import schema from "../../protocol/protocol.schema.json";
import Ajv from "ajv";
describe("protocol boundary", () => {
  it("rejects malformed, binary and oversized frames", () => {
    for (const value of [
      "{",
      "null",
      "[]",
      "{}",
      "x".repeat(MAX_MESSAGE + 1),
      new ArrayBuffer(8),
    ])
      expect(() => parseFrame(value)).toThrow();
  });
  it("requires a proof before application traffic", () => {
    expect(validClientFrame({ type: "rpc", seq: 1, data: "abcd" }, "new")).toBe(
      false,
    );
    expect(
      validClientFrame({ type: "auth.start", a: "01".repeat(256) }, "new"),
    ).toBe(true);
    expect(
      validClientFrame(
        { type: "auth.proof", proof: "ab".repeat(32) },
        "challenge",
      ),
    ).toBe(true);
    expect(
      validClientFrame({ type: "rpc", seq: 1, data: "abcd" }, "authorized"),
    ).toBe(true);
    expect(
      validClientFrame(
        { type: "rpc", seq: 1, data: "x".repeat(30001) },
        "authorized",
      ),
    ).toBe(false);
  });
  it("requires a fresh resume proof before allowing application traffic", () => {
    expect(
      validClientFrame(
        { type: "auth.resume.start", ticket: "ab".repeat(16) },
        "new",
      ),
    ).toBe(true);
    expect(
      validClientFrame({ type: "auth.resume.start", ticket: "bad" }, "new"),
    ).toBe(false);
    expect(
      validClientFrame(
        { type: "auth.resume.proof", proof: "ab".repeat(32) },
        "resume",
      ),
    ).toBe(true);
    expect(
      validClientFrame(
        { type: "auth.resume.proof", proof: "ab".repeat(32) },
        "new",
      ),
    ).toBe(false);
    expect(
      validClientFrame({ type: "rpc", seq: 1, data: "abcd" }, "resume"),
    ).toBe(false);
  });
  it("validates friendly names and requires identity proof", async () => {
    expect(remoteName.test("studio")).toBe(true);
    expect(remoteName.test(`studio--${"a".repeat(32)}`)).toBe(false);
    expect(
      await verifyRegistration(`studio--${"a".repeat(32)}`, "challenge", {
        name: "studio",
        publicKey: "a".repeat(64),
        signature: "0".repeat(128),
      }),
    ).toBe(false);
  });
  it("defines every operation and rejects arbitrary HTTP proxy commands", () => {
    expect(schema.oneOf.map((x) => x.properties.op.const).sort()).toEqual(
      [...operations].sort(),
    );
    const validate = new Ajv({ strict: false, validateFormats: false }).compile(
      schema,
    );
    expect(
      validate({
        v: 1,
        id: "1",
        op: "route.set",
        params: { receiver: "one", source: "Camera A" },
      }),
    ).toBe(true);
    expect(
      validate({
        v: 1,
        id: "1",
        op: "http.fetch",
        params: { url: "http://192.168.1.1" },
      }),
    ).toBe(false);
    expect(
      validate({
        v: 1,
        id: "1",
        op: "wifi.reorder",
        params: { ids: ["one", "one"] },
      }),
    ).toBe(false);
  });
});
