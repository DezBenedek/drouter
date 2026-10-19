import { describe, it, expect } from "vitest";
import Ajv from "ajv";
import schema from "../../protocol/protocol.schema.json";
import { dictionaries } from "../../firmware/web/shared/i18n.js";
import { validClientFrame } from "../src/relay";
const validate = new Ajv({ strict: false, validateFormats: false }).compile(
  schema,
);
const request = (op: string, params: unknown) => ({
  v: 1,
  id: "test",
  op,
  params,
});
describe("Modification 3 protocol and translation coverage", () => {
  it("requires confirmed revisions for source, profile, and Event Mode edits", () => {
    for (const op of [
      "sources.saved.remove",
      "simple.delete",
      "event.enable",
      "event.disable",
    ]) {
      const params = op.startsWith("event.") ? {} : { id: "one" };
      expect(validate(request(op, params))).toBe(false);
      expect(
        validate(
          request(op, { ...params, confirmed: false, expected_revision: 1 }),
        ),
      ).toBe(false);
      expect(
        validate(
          request(op, { ...params, confirmed: true, expected_revision: 1 }),
        ),
      ).toBe(true);
    }
  });
  it("accepts one stored button ID and rejects client target overrides", () => {
    expect(validate(request("simple.action.execute", { id: "teacher" }))).toBe(
      true,
    );
    expect(
      validate(
        request("simple.action.execute", {
          id: "teacher",
          receiver: "one",
          source: "Camera A",
        }),
      ),
    ).toBe(false);
  });
  it("uses Unicode scalar length for protocol password validation", () => {
    for (const password of ["1234", "árví", "😀😀😀😀"])
      expect(
        validate(
          request("auth.password.change", {
            password,
            confirmed: true,
            expected_revision: 1,
          }),
        ),
      ).toBe(true);
    for (const password of ["123", "😀😀😀"])
      expect(
        validate(
          request("auth.password.change", {
            password,
            confirmed: true,
            expected_revision: 1,
          }),
        ),
      ).toBe(false);
  });
  it("bounds anonymous authentication proof arrays on the relay", () => {
    const proof = "ab".repeat(32);
    expect(
      validClientFrame(
        { type: "auth.proof", proof, proofs: [proof, proof] },
        "challenge",
      ),
    ).toBe(true);
    expect(
      validClientFrame(
        { type: "auth.proof", proof, proofs: Array(10).fill(proof) },
        "challenge",
      ),
    ).toBe(false);
    expect(
      validClientFrame(
        { type: "auth.proof", proof, proofs: ["invalid"] },
        "challenge",
      ),
    ).toBe(false);
  });
  it("has Hungarian translations for every dictionary entry and all required workflows", () => {
    expect(Object.keys(dictionaries.en).length).toBeGreaterThan(300);
    expect(Object.keys(dictionaries.en).sort()).toEqual(
      Object.keys(dictionaries.hu).sort(),
    );
    for (const key of [
      "Routing",
      "Sources",
      "Simple Mode",
      "Simple Modes",
      "Event Mode",
      "Contact",
      "Language",
      "Password",
      "Save source",
      "Other source",
      "All Sources",
      "Connect to your DRouter",
      "Welcome to DRouter",
      "Wi-Fi password",
      "Apply preset",
      "Confirm changes",
      "Authentication failed",
      "Simple Mode is temporarily locked by the administrator.",
    ]) {
      expect(dictionaries.en[key as keyof typeof dictionaries.en]).toBeTruthy();
      expect(dictionaries.hu[key as keyof typeof dictionaries.hu]).toBeTruthy();
      expect(dictionaries.hu[key as keyof typeof dictionaries.hu]).not.toBe(
        key,
      );
    }
  });
});
