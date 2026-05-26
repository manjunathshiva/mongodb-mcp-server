import { describe, it, expect } from "vitest";
import {
    getHostType,
    getConnectionStringInfo,
    type AtlasClusterConnectionInfo,
} from "../../../src/common/connectionInfo.js";

describe("connectionInfo", () => {
    describe("getHostType", () => {
        it("should return 'atlas' when connection string is an Atlas connection string", () => {
            const atlasConnectionString = "mongodb+srv://cluster.mongodb.net/database";

            const result = getHostType(atlasConnectionString);

            expect(result).toBe("atlas");
        });

        it("should return 'unknown' when connection string is not an Atlas connection string", () => {
            const localConnectionString = "mongodb://localhost:27017/database";

            const result = getHostType(localConnectionString);

            expect(result).toBe("unknown");
        });

        it("should return 'unknown' for empty connection string", () => {
            const emptyConnectionString = "";

            const result = getHostType(emptyConnectionString);

            expect(result).toBe("unknown");
        });

        it("should handle Atlas connection strings with query parameters", () => {
            const atlasConnectionStringWithParams =
                "mongodb+srv://cluster.mongodb.net/database?authMechanism=MONGODB-X509&authSource=$external&tls=true&tlsCertificateKeyFile=/p.pem";

            const result = getHostType(atlasConnectionStringWithParams);

            expect(result).toBe("atlas");
        });
    });

    describe("getConnectionStringInfo", () => {
        // Note: assertX509ConnectionString runs before this function in real
        // request paths, so any non-X.509 connection string is rejected at
        // config-parse time. getConnectionStringInfo therefore unconditionally
        // returns authType "x.509".
        const atlasClusterInfo: AtlasClusterConnectionInfo = {
            username: "u",
            projectId: "p",
            clusterName: "c",
            instanceType: "FREE",
            expiryDate: new Date(0),
        };

        it("returns authType='x.509' for local connection strings", () => {
            const result = getConnectionStringInfo(
                "mongodb://localhost:27017/?authMechanism=MONGODB-X509&authSource=$external&tls=true&tlsCertificateKeyFile=/p.pem"
            );
            expect(result).toEqual({ authType: "x.509", hostType: "unknown" });
        });

        it("returns authType='x.509' for Atlas connection strings", () => {
            const result = getConnectionStringInfo(
                "mongodb+srv://cluster.mongodb.net/?authMechanism=MONGODB-X509&authSource=$external&tls=true&tlsCertificateKeyFile=/p.pem"
            );
            expect(result).toEqual({ authType: "x.509", hostType: "atlas" });
        });

        it("returns hostType='atlas' when atlasInfo is provided regardless of connection string", () => {
            const result = getConnectionStringInfo(
                "mongodb://localhost:27017/?authMechanism=MONGODB-X509&authSource=$external&tls=true&tlsCertificateKeyFile=/p.pem",
                atlasClusterInfo
            );
            expect(result).toEqual({ authType: "x.509", hostType: "atlas" });
        });
    });
});
