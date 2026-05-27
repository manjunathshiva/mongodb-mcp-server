import type { Secret } from "mongodb-redact";
export type { Secret } from "mongodb-redact";

/**
 * Per-owner secret store. Every Keychain instance is explicitly owned
 * by something — a bootstrap pass, an MCP session, the setup CLI — and
 * passed in to whoever needs it. There is no process-wide singleton on
 * this class; the previous `Keychain.root` static was removed in Phase E
 * to avoid cross-session secret leakage and to make ownership testable.
 *
 * Loggers that need to redact log lines should take a `Keychain` (or a
 * {@link CompositeKeychain}) by reference at construction time and call
 * `allSecrets` at emit time.
 */
export class Keychain {
    private secrets: Secret[] = [];

    register(value: Secret["value"], kind: Secret["kind"]): void {
        this.secrets.push({ value, kind });
    }

    clearAllSecrets(): void {
        this.secrets = [];
    }

    get allSecrets(): Secret[] {
        return [...this.secrets];
    }
}

/**
 * Read-through union of several keychains.
 *
 * Used when one logger needs to redact secrets from multiple ownership
 * scopes at once — typically a bootstrap keychain (containing process-
 * level config secrets like the Atlas API client secret) composed with a
 * per-session keychain (containing anything the session registered at
 * runtime). The composite exposes the same {@link Keychain} contract so
 * loggers don't need to know they're holding a composite vs a single
 * scope.
 *
 * `register` always lands in the FIRST delegate; the rest are read-only
 * from the composite's perspective. This keeps ownership unambiguous:
 * each composite has exactly one "writable" backing keychain, and the
 * others are sources of pre-registered secrets.
 */
export class CompositeKeychain extends Keychain {
    private readonly delegates: readonly Keychain[];

    constructor(delegates: readonly Keychain[]) {
        super();
        if (delegates.length === 0) {
            throw new Error("CompositeKeychain requires at least one delegate keychain.");
        }
        this.delegates = delegates;
    }

    override register(value: Secret["value"], kind: Secret["kind"]): void {
        this.delegates[0]!.register(value, kind);
    }

    override clearAllSecrets(): void {
        for (const delegate of this.delegates) {
            delegate.clearAllSecrets();
        }
    }

    override get allSecrets(): Secret[] {
        const result: Secret[] = [];
        for (const delegate of this.delegates) {
            result.push(...delegate.allSecrets);
        }
        return result;
    }
}
