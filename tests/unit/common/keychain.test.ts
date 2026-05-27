import { CompositeKeychain, Keychain } from "../../../src/common/keychain.js";
import { describe, beforeEach, it, expect } from "vitest";

describe("Keychain", () => {
    let keychain: Keychain;

    beforeEach(() => {
        keychain = new Keychain();
    });

    it("registers a new secret", () => {
        keychain.register("123456", "password");
        expect(keychain.allSecrets).toEqual([{ value: "123456", kind: "password" }]);
    });

    it("clearAllSecrets removes existing entries", () => {
        keychain.register("123456", "password");
        expect(keychain.allSecrets).toEqual([{ value: "123456", kind: "password" }]);

        keychain.clearAllSecrets();
        keychain.register("654321", "user");
        expect(keychain.allSecrets).toEqual([{ value: "654321", kind: "user" }]);
    });

    it("each instance has its own scope (no process-wide singleton)", () => {
        // Phase E invariant: two independently-constructed keychains MUST NOT
        // share state. The pre-Phase-E `Keychain.root` static was removed
        // precisely to make this property hold; this test guards the
        // regression.
        const a = new Keychain();
        const b = new Keychain();
        a.register("only-in-a", "password");
        b.register("only-in-b", "password");
        expect(a.allSecrets).toEqual([{ value: "only-in-a", kind: "password" }]);
        expect(b.allSecrets).toEqual([{ value: "only-in-b", kind: "password" }]);
    });
});

describe("CompositeKeychain", () => {
    it("unions secrets from every delegate when read", () => {
        const bootstrap = new Keychain();
        const session = new Keychain();
        bootstrap.register("boot-secret", "password");
        session.register("session-secret", "user");

        const composite = new CompositeKeychain([session, bootstrap]);

        expect(composite.allSecrets).toEqual([
            { value: "session-secret", kind: "user" },
            { value: "boot-secret", kind: "password" },
        ]);
    });

    it("register() writes only to the first delegate", () => {
        const writable = new Keychain();
        const readOnly = new Keychain();
        const composite = new CompositeKeychain([writable, readOnly]);

        composite.register("new-secret", "password");

        expect(writable.allSecrets).toEqual([{ value: "new-secret", kind: "password" }]);
        expect(readOnly.allSecrets).toEqual([]);
    });

    it("clearAllSecrets() clears every delegate", () => {
        const a = new Keychain();
        const b = new Keychain();
        a.register("a", "password");
        b.register("b", "password");
        const composite = new CompositeKeychain([a, b]);

        composite.clearAllSecrets();

        expect(a.allSecrets).toEqual([]);
        expect(b.allSecrets).toEqual([]);
    });

    it("refuses construction with no delegates", () => {
        expect(() => new CompositeKeychain([])).toThrow(/at least one delegate/i);
    });
});
