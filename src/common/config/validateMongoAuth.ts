import { ConnectionString } from "mongodb-connection-string-url";
import type { MongoClientOptions } from "mongodb";
import { ErrorCodes, MongoDBError } from "../errors.js";

/**
 * Policy: this server only accepts MongoDB connection strings that use X.509
 * client-certificate authentication. Username/password, SCRAM, LDAP, OIDC, and
 * Kerberos auth mechanisms are rejected at config-parse time and cannot be
 * re-enabled by configuration.
 *
 * The certificate file path is required to be present and non-empty, but its
 * existence on disk is NOT checked here. In Azure deployments the cert is
 * mounted dynamically into the container after startup; the MongoDB driver
 * will surface a clear error at connect time if the file is missing.
 *
 * Throws MongoDBError(MisconfiguredConnectionString) with a message naming the
 * specific violation so misconfigurations are easy to fix.
 */
export function assertX509ConnectionString(connectionString: string): void {
    let url: ConnectionString;
    try {
        url = new ConnectionString(connectionString);
    } catch (cause) {
        throw new MongoDBError(
            ErrorCodes.MisconfiguredConnectionString,
            `Invalid MongoDB connection string: ${(cause as Error).message}`
        );
    }

    if (url.username || url.password) {
        throw new MongoDBError(
            ErrorCodes.MisconfiguredConnectionString,
            "Username/password authentication is disabled by policy; only X.509 client-certificate auth is permitted. " +
                "Remove the credentials from the connection string."
        );
    }

    const params = url.typedSearchParams<MongoClientOptions>();

    const authMechanism = params.get("authMechanism");
    if (authMechanism !== "MONGODB-X509") {
        throw new MongoDBError(
            ErrorCodes.MisconfiguredConnectionString,
            `authMechanism must be 'MONGODB-X509' (got ${authMechanism ? `'${authMechanism}'` : "none"}). ` +
                "This server only supports X.509 client-certificate authentication."
        );
    }

    const authSource = params.get("authSource");
    if (authSource !== "$external") {
        throw new MongoDBError(
            ErrorCodes.MisconfiguredConnectionString,
            `authSource must be '$external' for X.509 auth (got ${authSource ? `'${authSource}'` : "none"}).`
        );
    }

    const tls = params.get("tls") ?? params.get("ssl");
    if (tls !== "true") {
        throw new MongoDBError(
            ErrorCodes.MisconfiguredConnectionString,
            `tls must be 'true' for X.509 auth (got ${tls ? `'${tls}'` : "none"}).`
        );
    }

    const certKeyFile = params.get("tlsCertificateKeyFile");
    if (!certKeyFile || certKeyFile.trim().length === 0) {
        throw new MongoDBError(
            ErrorCodes.MisconfiguredConnectionString,
            "tlsCertificateKeyFile must be set to a non-empty path for X.509 auth. " +
                "The file does not need to exist at startup (it may be mounted dynamically), but the parameter is required."
        );
    }
}
