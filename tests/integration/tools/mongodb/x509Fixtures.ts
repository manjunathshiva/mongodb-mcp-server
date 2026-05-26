import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Absolute paths to the static X.509 test fixture certs committed under
 * tests/fixtures/x509/. See that directory's README for how they were
 * generated and why they live in git.
 */
export const X509_FIXTURES_DIR = path.resolve(__dirname, "..", "..", "..", "fixtures", "x509");
export const X509_CA_CRT = path.join(X509_FIXTURES_DIR, "ca.crt");
export const X509_SERVER_PEM = path.join(X509_FIXTURES_DIR, "server.pem");
export const X509_CLIENT_PEM = path.join(X509_FIXTURES_DIR, "client.pem");

/**
 * Distinguished name encoded in the committed client certificate.
 * mongod's createUser in `$external` requires this exact value as the
 * username, so it's centralised here to keep the cert and the fixture
 * code in sync.
 */
export const X509_CLIENT_SUBJECT = "CN=mongodb-mcp-test-client,OU=test-client,O=mongodb-mcp-test,C=US";

/**
 * Server arguments that turn an off-the-shelf mongod into an X.509-only
 * deployment compatible with the production policy enforced by
 * assertX509ConnectionString.
 *
 * - tlsMode=requireTLS forces TLS on every connection.
 * - tlsCertificateKeyFile / tlsCAFile point at the committed fixture certs.
 * - auth enforces the X.509 user we create after startup.
 * - tlsAllowConnectionsWithoutCertificates lets mongodb-runner's own
 *   internal probe connect with TLS but no client cert; combined with
 *   --auth this still requires authentication, which mongodb-runner
 *   satisfies through the auto-generated client key it appends to the
 *   CA file (see tlsAddClientKey).
 */
export function x509MongodArgs(): string[] {
    return [
        `--tlsMode=requireTLS`,
        `--tlsCertificateKeyFile=${X509_SERVER_PEM}`,
        `--tlsCAFile=${X509_CA_CRT}`,
        `--auth`,
        `--tlsAllowConnectionsWithoutCertificates`,
    ];
}

/**
 * Build the X.509 connection string a test (or the MCP server under test)
 * should use to authenticate as the committed client cert's user.
 *
 * @param baseConnectionString A connection string produced by
 *   mongodb-runner (host/port only — query params are replaced).
 */
export function toX509ConnectionString(baseConnectionString: string): string {
    const url = new URL(baseConnectionString.replace(/^mongodb:\/\//, "http://"));
    // Drop everything we don't want; build a fresh X.509 string.
    const host = url.host;
    const params = new URLSearchParams({
        authMechanism: "MONGODB-X509",
        authSource: "$external",
        tls: "true",
        tlsCertificateKeyFile: X509_CLIENT_PEM,
        tlsCAFile: X509_CA_CRT,
        directConnection: "true",
    });
    return `mongodb://${host}/?${params.toString()}`;
}
