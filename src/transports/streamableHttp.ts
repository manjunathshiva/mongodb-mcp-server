import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { LoggerBase } from "../common/logging/index.js";
import { CompositeLogger, LogId } from "../common/logging/index.js";
import { type ISessionStore, type CreateSessionStoreFn, createDefaultSessionStore } from "../common/sessionStore.js";
import {
    TransportRunnerBase,
    type TransportRunnerConfig,
    type RequestContext,
    type CustomizableSessionOptions,
} from "./base.js";
import type { CustomizableServerOptions, Server, UserConfig } from "../lib.js";
import { applyConfigOverrides } from "../common/config/configOverrides.js";
import type { Metrics, DefaultMetrics } from "@mongodb-js/mcp-metrics";
import type { MonitoringServerFeature } from "../common/schemas.js";
import {
    MCPHttpServer,
    type CreateMcpHttpServerFn,
    createDefaultMcpHttpServer,
    type MCPHttpServerConstructorArgs,
} from "./mcpHttpServer.js";
import { MonitoringServer, type CreateMonitoringServerFn, createDefaultMonitoringServer } from "./monitoringServer.js";

export { createDefaultMonitoringServer, MonitoringServer, createDefaultMcpHttpServer, MCPHttpServer };
export type { CreateMonitoringServerFn, MonitoringServerFeature, CreateMcpHttpServerFn, MCPHttpServerConstructorArgs };

/**
 * Configuration options for extracting monitoring server settings from UserConfig.
 */
export type MonitoringServerConfig = {
    monitoringServerHost?: string;
    monitoringServerPort?: number;
    healthCheckHost?: string;
    healthCheckPort?: number;
    monitoringServerFeatures: MonitoringServerFeature[];
};

/**
 * Configuration options for the StreamableHttpRunner.
 * Extends the base TransportRunnerConfig with HTTP-transport-specific options.
 *
 * @template TUserConfig - The type of user configuration
 * @template TMetrics - The type of metrics definitions
 */
export type StreamableHttpTransportRunnerConfig<
    TUserConfig extends UserConfig = UserConfig,
    TMetrics extends DefaultMetrics = DefaultMetrics,
    TContext = unknown,
> = TransportRunnerConfig<TUserConfig, TMetrics> & {
    /**
     * When provided, the runner will use this function to create the monitoring server
     * instead of using the default MonitoringServer constructor. This allows for
     * customizing the monitoring server (e.g., adding custom routes) while still
     * receiving the constructor arguments that would normally be used.
     */
    createMonitoringServer?: CreateMonitoringServerFn<TMetrics>;

    /**
     * When provided, the runner will use this function to create the session store
     * instead of using the default SessionStore constructor. This allows for
     * customizing session storage (e.g., Redis-backed storage, custom timeout behavior,
     * or shared session state across instances) while still receiving the constructor
     * arguments that would normally be used.
     */
    createSessionStore?: CreateSessionStoreFn<StreamableHTTPServerTransport, TMetrics>;

    /**
     * When provided, the runner will use this function to create the MCP HTTP server
     * instead of using the default MCPHttpServer constructor. This allows for
     * customizing the HTTP server (e.g., adding pre-route middleware) while still
     * receiving the constructor arguments that would normally be used.
     */
    createMcpHttpServer?: CreateMcpHttpServerFn<TUserConfig, TContext>;
};

export {
    JSON_RPC_ERROR_CODE_PROCESSING_REQUEST_FAILED,
    JSON_RPC_ERROR_CODE_SESSION_ID_REQUIRED,
    JSON_RPC_ERROR_CODE_SESSION_ID_INVALID,
    JSON_RPC_ERROR_CODE_SESSION_NOT_FOUND,
    JSON_RPC_ERROR_CODE_INVALID_REQUEST,
    JSON_RPC_ERROR_CODE_DISALLOWED_EXTERNAL_SESSION,
} from "./jsonRpcErrorCodes.js";

export class StreamableHttpRunner<
    TUserConfig extends UserConfig = UserConfig,
    TContext = unknown,
    TMetrics extends DefaultMetrics = DefaultMetrics,
> extends TransportRunnerBase<TUserConfig, TContext, TMetrics> {
    private mcpServer: MCPHttpServer<TUserConfig, TContext> | undefined;
    private readonly monitoringServer: MonitoringServer<TMetrics> | undefined;
    private readonly sessionStore: ISessionStore<StreamableHTTPServerTransport>;
    private readonly createMcpHttpServer: CreateMcpHttpServerFn<TUserConfig, TContext>;

    constructor(config: StreamableHttpTransportRunnerConfig<TUserConfig, TMetrics, TContext>) {
        super(config);
        this.createMcpHttpServer = config.createMcpHttpServer ?? createDefaultMcpHttpServer;

        this.sessionStore = (config.createSessionStore ?? createDefaultSessionStore<StreamableHTTPServerTransport>)({
            options: {
                idleTimeoutMS: this.userConfig.idleTimeoutMs,
                notificationTimeoutMS: this.userConfig.notificationTimeoutMs,
            },
            logger: this.logger,
            metrics: this.metrics,
        });
        // Create monitoring server if host/port are configured
        const host = config.userConfig.monitoringServerHost ?? config.userConfig.healthCheckHost;
        const port = config.userConfig.monitoringServerPort ?? config.userConfig.healthCheckPort;
        if (host !== undefined && port !== undefined) {
            this.monitoringServer = (config.createMonitoringServer ?? createDefaultMonitoringServer)({
                host,
                port,
                features: config.userConfig.monitoringServerFeatures,
                logger: this.logger,
                metrics: this.metrics,
            });
        }
    }

    /** Starts the transport runner. */
    async start({
        serverOptions,
        sessionOptions,
    }: {
        /** Server options to use when creating the server. */
        serverOptions?: CustomizableServerOptions<TUserConfig, TContext>;
        /** Session options to use when creating the session. */
        sessionOptions?: CustomizableSessionOptions<TUserConfig>;
    } = {}): Promise<void> {
        this.validateConfig();

        this.mcpServer = this.createMcpHttpServer({
            userConfig: this.userConfig,
            createServerForRequest: ({ request }): Promise<Server<TUserConfig, TContext>> =>
                this.createServerForRequest({ request, serverOptions, sessionOptions }),
            logger: this.logger,
            metrics: this.metrics,
            sessionStore: this.sessionStore,
        });
        await this.mcpServer.start();

        // Start the monitoring server if one exists (either externally provided or created in constructor)
        await this.monitoringServer?.start();

        this.logger.info({
            message: "Streamable HTTP Transport started",
            context: "streamableHttpTransport",
            id: LogId.streamableHttpTransportStarted,
        });
    }

    async closeTransport(): Promise<void> {
        await Promise.all([this.mcpServer?.stop(), this.monitoringServer?.stop()]);
    }

    private shouldWarnAboutHttpHost(httpHost: string): boolean {
        const host = httpHost.trim();
        const safeHosts = new Set(["127.0.0.1", "localhost", "::1"]);
        return host === "0.0.0.0" || host === "::" || (!safeHosts.has(host) && host !== "");
    }

    /**
     * Creates a new MCP server instance for a given request.
     */
    protected async createServerForRequest({
        request,
        serverOptions,
        sessionOptions,
    }: {
        request: RequestContext;
        /** Upstream `serverOptions` passed from running `runner.start({ serverOptions })` method */
        serverOptions?: CustomizableServerOptions<TUserConfig, TContext>;
        /** Upstream `sessionOptions` passed from running `runner.start({ sessionOptions })` method */
        sessionOptions?: CustomizableSessionOptions<TUserConfig>;
    }): Promise<Server<TUserConfig, TContext>> {
        let userConfig: TUserConfig = sessionOptions?.userConfig ?? this.userConfig;

        if (this.createSessionConfig) {
            userConfig = await this.createSessionConfig({ userConfig, request });
        } else {
            userConfig = applyConfigOverrides({ baseConfig: userConfig, request });
        }

        const logger = new CompositeLogger(this.logger);

        return this.createServer({
            userConfig,
            logger,
            serverOptions: {
                tools: this.tools,
                ...serverOptions,
            },
            sessionOptions: {
                ...sessionOptions,
                connectionErrorHandler: sessionOptions?.connectionErrorHandler ?? this.connectionErrorHandler,
                connectionManager:
                    sessionOptions?.connectionManager ??
                    (await this.createConnectionManager({
                        logger,
                        deviceId: this.deviceId,
                        userConfig,
                    })),
                atlasLocalClient: sessionOptions?.atlasLocalClient ?? (await this.createAtlasLocalClient({ logger })),
                apiClient:
                    sessionOptions?.apiClient ??
                    (userConfig.apiClientId && userConfig.apiClientSecret
                        ? this.createApiClient(
                              {
                                  baseUrl: userConfig.apiBaseUrl,
                                  credentials: {
                                      clientId: userConfig.apiClientId,
                                      clientSecret: userConfig.apiClientSecret,
                                  },
                                  requestContext: request,
                              },
                              logger
                          )
                        : undefined),
            },
        });
    }

    private validateConfig(): void {
        if ((this.userConfig.healthCheckHost === undefined) !== (this.userConfig.healthCheckPort === undefined)) {
            throw new Error("Both healthCheckHost and healthCheckPort must be defined to enable health checks.");
        }

        if (
            (this.userConfig.monitoringServerHost === undefined) !==
            (this.userConfig.monitoringServerPort === undefined)
        ) {
            throw new Error(
                "Both monitoringServerHost and monitoringServerPort must be defined to enable the monitoring server."
            );
        }

        const effectivePort = this.userConfig.monitoringServerPort ?? this.userConfig.healthCheckPort;
        if (effectivePort !== undefined && effectivePort !== 0 && effectivePort === this.userConfig.httpPort) {
            throw new Error("Monitoring server port cannot be the same as httpPort.");
        }

        // Config-shape rule: oauthIssuer and oauthAudience must be set
        // together. Specifying one without the other is almost certainly
        // a misconfiguration; fail loudly instead of silently disabling
        // auth. (Checked before the bind guard so the error is precise.)
        if (Boolean(this.userConfig.oauthIssuer) !== Boolean(this.userConfig.oauthAudience)) {
            throw new Error(
                "oauthIssuer and oauthAudience must be configured together. " +
                    `Got oauthIssuer=${this.userConfig.oauthIssuer ?? "<unset>"}, ` +
                    `oauthAudience=${this.userConfig.oauthAudience ?? "<unset>"}.`
            );
        }

        const hasInAppOauth = Boolean(this.userConfig.oauthIssuer && this.userConfig.oauthAudience);
        const hasSharedSecretHeader = Object.keys(this.userConfig.httpHeaders ?? {}).length > 0;
        const isPlatformAuth = this.userConfig.httpAuthMode === "platform";

        // OWASP MCP07: 'platform' mode delegates identity verification to an
        // upstream reverse proxy / gateway (e.g. Azure Container Apps
        // EasyAuth). To keep the guarantee that the app itself never serves
        // an unauthenticated request, we REQUIRE at least one httpHeaders
        // shared-secret entry as a second, app-enforced layer. Refusing here
        // means the defense-in-depth is mandatory and code-enforced rather
        // than operator-remembered.
        if (isPlatformAuth && !hasSharedSecretHeader) {
            throw new Error(
                "Refusing to start: httpAuthMode=platform requires at least one httpHeaders shared-secret entry " +
                    "so the app rejects unauthenticated requests even though identity is verified at the edge. " +
                    "Set httpHeaders (e.g. an 'x-mcp-key' header), or use httpAuthMode=oauth for in-app token validation."
            );
        }

        if (this.shouldWarnAboutHttpHost(this.userConfig.httpHost)) {
            if (!hasInAppOauth && !isPlatformAuth) {
                // OWASP MCP07: a non-loopback bind without authentication is
                // an open back door into the MCP server (and through it, the
                // configured MongoDB cluster). Refuse to start rather than
                // log a warning and continue.
                throw new Error(
                    `Refusing to start: httpHost=${this.userConfig.httpHost} is non-loopback and no authentication is configured. ` +
                        `Set oauthIssuer + oauthAudience for in-app bearer-token auth, ` +
                        `set httpAuthMode=platform (with an httpHeaders shared secret) when an authenticating gateway sits in front, ` +
                        `or bind to 127.0.0.1 / localhost / ::1 for local-only access.`
                );
            }

            if (isPlatformAuth) {
                // Loud, auditable acknowledgement that the app is trusting an
                // upstream gateway for identity. Operators MUST ensure that
                // gateway (e.g. ACA EasyAuth) actually validates callers.
                this.logger.warning({
                    id: LogId.streamableHttpTransportHttpHostWarning,
                    context: "streamableHttpTransport",
                    message:
                        `Binding to ${this.userConfig.httpHost} with httpAuthMode=platform: identity verification is DELEGATED to an upstream gateway ` +
                        `(e.g. Azure Container Apps EasyAuth / Microsoft Entra). The app enforces a shared-secret header as a second layer, ` +
                        `but you MUST ensure the gateway authenticates callers — otherwise the server is effectively exposed with only a static secret.`,
                    noRedaction: true,
                });
            } else {
                this.logger.warning({
                    id: LogId.streamableHttpTransportHttpHostWarning,
                    context: "streamableHttpTransport",
                    message: `Binding to ${this.userConfig.httpHost}. OAuth bearer-token authentication is enabled (issuer=${this.userConfig.oauthIssuer}).`,
                    noRedaction: true,
                });
            }
        }
    }
}

/**
 * Constructor arguments for creating a MonitoringServer instance.
 */
export type MonitoringServerConstructorArgs<TMetrics extends DefaultMetrics = DefaultMetrics> = {
    host: string;
    port: number;
    features: MonitoringServerFeature[];
    logger: LoggerBase;
    metrics: Metrics<TMetrics>;
};
