import os from "os";
import type { Keychain } from "../common/keychain.js";
import { redact } from "mongodb-redact";

export type Platform = "mac" | "windows" | "linux";
export const getPlatform = (): Platform | null => {
    switch (os.platform()) {
        case "win32":
            return "windows";
        case "darwin":
            return "mac";
        case "linux":
            return "linux";
        default:
            return null;
    }
};

/**
 * Format a thrown value as a human-readable error string with secrets
 * redacted. `keychain` is optional because some callers (file-path
 * errors during config-file writes in aiTool.ts) have no per-setup
 * context to thread; the empty-list path is safe for those - they
 * format paths and parser errors, not user-supplied secrets.
 */
export const formatError = (error: unknown, keychain?: Keychain): string => {
    const message = error instanceof Error ? error.message : String(error);
    return redact(message, keychain?.allSecrets ?? []);
};
