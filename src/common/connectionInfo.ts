import { isAtlas } from "mongodb-build-info";

/**
 * The host type of the connection string. Some values (e.g. local) are not yet supported, tools mostly
 * will return "unknown" for these values.
 */
export type ConnectionStringHostType = "local" | "atlas" | "atlas_local" | "unknown";

/**
 * Authentication mechanism for a MongoDB connection. This server enforces
 * X.509-only auth at config-parse time (see assertX509ConnectionString), so
 * only the "x.509" variant is ever observed at runtime. The union is kept as
 * a single-case type instead of a string literal alias so future expansion
 * (e.g. adding a server-side principal-based auth) can introduce a new case
 * without a type-only breaking change.
 */
export type ConnectionStringAuthType = "x.509";

/**
 * ConnectionStringInfo contains connection string metadata
 * without keeping the full connection string.
 */
export interface ConnectionStringInfo {
    authType: ConnectionStringAuthType;
    hostType: ConnectionStringHostType;
}

/**
 * Atlas cluster connection info containing details about the connected Atlas cluster.
 * When provided, indicates the connection is to an Atlas cluster.
 */
export interface AtlasClusterConnectionInfo {
    username: string;
    projectId: string;
    clusterName: string;
    instanceType: "FREE" | "FLEX" | "DEDICATED";
    provider?: string;
    region?: string;
    expiryDate: Date;
}

/**
 * Get metadata about the connection string including authentication type and host type.
 * @param connectionString - The connection string to analyze.
 * @param atlasInfo - Optional Atlas cluster connection info. If provided, host type is set to "atlas".
 * @returns The connection string metadata.
 */
export function getConnectionStringInfo(
    connectionString: string,
    atlasInfo?: AtlasClusterConnectionInfo
): ConnectionStringInfo {
    return {
        authType: "x.509",
        hostType: atlasInfo !== undefined ? "atlas" : getHostType(connectionString),
    };
}

/**
 * Get the host type from the connection string.
 * @param connectionString - The connection string to get the host type from.
 * @returns The host type.
 */
export function getHostType(connectionString: string): ConnectionStringHostType {
    if (isAtlas(connectionString)) {
        return "atlas";
    }
    return "unknown";
}
