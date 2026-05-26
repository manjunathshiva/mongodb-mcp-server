import { describe, it, expect } from "vitest";
import { assertX509ConnectionString } from "../../../../src/common/config/validateMongoAuth.js";
import { ErrorCodes, MongoDBError } from "../../../../src/common/errors.js";

// The canonical example connection string supplied by ops; serves as the
// positive-control fixture for every assertion in this suite.
const VALID_X509 =
    "mongodb+srv://example.mongodb.net/?authSource=%24external&authMechanism=MONGODB-X509&tls=true&tlsCertificateKeyFile=/etc/secrets/client.pem";

function expectMisconfigured(connectionString: string, snippet: RegExp): void {
    try {
        assertX509ConnectionString(connectionString);
    } catch (error) {
        expect(error).toBeInstanceOf(MongoDBError);
        const mErr = error as MongoDBError;
        expect(mErr.code).toBe(ErrorCodes.MisconfiguredConnectionString);
        expect(mErr.message).toMatch(snippet);
        return;
    }
    throw new Error("expected assertX509ConnectionString to throw");
}

describe("assertX509ConnectionString", () => {
    it("accepts the canonical X.509 Atlas connection string", () => {
        expect(() => assertX509ConnectionString(VALID_X509)).not.toThrow();
    });

    it("accepts a self-hosted X.509 connection string", () => {
        expect(() =>
            assertX509ConnectionString(
                "mongodb://mongo.internal:27017/?authMechanism=MONGODB-X509&authSource=$external&tls=true&tlsCertificateKeyFile=/p.pem"
            )
        ).not.toThrow();
    });

    it("rejects connection strings with an embedded username", () => {
        expectMisconfigured(
            "mongodb+srv://alice@example.mongodb.net/?authMechanism=MONGODB-X509&authSource=$external&tls=true&tlsCertificateKeyFile=/p.pem",
            /username\/password authentication is disabled/i
        );
    });

    it("rejects connection strings with an embedded username and password", () => {
        expectMisconfigured(
            "mongodb+srv://alice:s3cret@example.mongodb.net/?authMechanism=MONGODB-X509&authSource=$external&tls=true&tlsCertificateKeyFile=/p.pem",
            /username\/password authentication is disabled/i
        );
    });

    it("rejects authMechanism=SCRAM-SHA-256", () => {
        expectMisconfigured(
            "mongodb+srv://example.mongodb.net/?authMechanism=SCRAM-SHA-256",
            /authMechanism must be 'MONGODB-X509'/i
        );
    });

    it("rejects connection strings missing the authMechanism parameter entirely", () => {
        expectMisconfigured("mongodb://localhost:27017/", /authMechanism must be 'MONGODB-X509'/i);
    });

    it("rejects authSource values other than $external", () => {
        expectMisconfigured(
            "mongodb+srv://example.mongodb.net/?authMechanism=MONGODB-X509&authSource=admin&tls=true&tlsCertificateKeyFile=/p.pem",
            /authSource must be '\$external'/i
        );
    });

    it("rejects tls=false", () => {
        expectMisconfigured(
            "mongodb+srv://example.mongodb.net/?authMechanism=MONGODB-X509&authSource=$external&tls=false&tlsCertificateKeyFile=/p.pem",
            /tls must be 'true'/i
        );
    });

    it("rejects missing tls parameter", () => {
        expectMisconfigured(
            "mongodb+srv://example.mongodb.net/?authMechanism=MONGODB-X509&authSource=$external&tlsCertificateKeyFile=/p.pem",
            /tls must be 'true'/i
        );
    });

    it("rejects missing tlsCertificateKeyFile", () => {
        expectMisconfigured(
            "mongodb+srv://example.mongodb.net/?authMechanism=MONGODB-X509&authSource=$external&tls=true",
            /tlsCertificateKeyFile must be set/i
        );
    });

    it("rejects empty tlsCertificateKeyFile", () => {
        expectMisconfigured(
            "mongodb+srv://example.mongodb.net/?authMechanism=MONGODB-X509&authSource=$external&tls=true&tlsCertificateKeyFile=",
            /tlsCertificateKeyFile must be set/i
        );
    });

    it("rejects malformed connection strings", () => {
        expectMisconfigured("not-a-valid-uri", /invalid mongodb connection string/i);
    });

    it("accepts the URL-encoded form of $external (the form ops actually uses)", () => {
        // %24external decodes to $external; verifies the validator does not
        // require the user to pre-decode the value.
        expect(() =>
            assertX509ConnectionString(
                "mongodb+srv://example.mongodb.net/?authSource=%24external&authMechanism=MONGODB-X509&tls=true&tlsCertificateKeyFile=/p.pem"
            )
        ).not.toThrow();
    });
});
