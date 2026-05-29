@description('Location of resources')
param location string = resourceGroup().location

@description('Existing Azure Container Apps environment name to reuse. Leave empty to create a new environment.')
param containerAppEnvironmentName string = ''

@description('Name of the Container App')
param containerAppName string = 'mongo-mcp-server-app'

@description('Container image to deploy. For the hardened source build, push deploy/azure/Dockerfile to your ACR and set e.g. <registry>.azurecr.io/mongodb-mcp-server:hardened')
param containerImage string

@description('ACR login server (e.g. myregistry.azurecr.io) for private image pulls. Leave empty for a public image (e.g. Docker Hub).')
param acrLoginServer string = ''

@description('Resource ID of a pre-created user-assigned managed identity that has AcrPull on the registry. Recommended for private ACR: it lets the FIRST deploy pull the image (a system-assigned identity does not exist until the app is created, so its first pull would fail). Leave empty to fall back to the app\'s system-assigned identity (then grant AcrPull to the containerAppPrincipalId output and redeploy).')
param acrPullIdentityResourceId string = ''

@description('Container CPU (vCPU) as string. Allowed: 0.25 - 2.0 in 0.25 increments')
@allowed([
  '0.25'
  '0.5'
  '0.75'
  '1.0'
  '1.25'
  '1.5'
  '1.75'
  '2.0'
])
param containerCpu string = '1.0'

// Convert CPU string to number (Bicep lacks float type; json() parses to number)
var containerCpuNumber = json(containerCpu)

@description('Container Memory (GB)')
@allowed([
  '0.5Gi'
  '1Gi'
  '2Gi'
  '4Gi'
])
param containerMemory string = '2Gi'

@description('Enable write (create/update) operations. Note: this hardened build has no delete tools regardless. true = read + metadata only.')
param readOnly bool = false

@description('Container HTTP port the MCP server listens on.')
param httpPort int = 8080

@description('Microsoft Entra authentication for the Container App edge (EasyAuth). NOAUTH = no edge identity check (dev only; the app-layer shared-secret header still applies). MicrosoftMIBasedAuth = enforce Entra at the edge (recommended; Foundry connects with Project Managed Identity).')
@allowed([
  'NOAUTH'
  'MicrosoftMIBasedAuth'
])
param authMode string = 'MicrosoftMIBasedAuth'

@description('Microsoft Entra Application (client) ID used when authMode is MicrosoftMIBasedAuth. This is the audience Foundry must request a token for.')
param authClientId string = ''

@description('OpenID issuer URL when authMode is MicrosoftMIBasedAuth. Example: https://login.microsoftonline.com/<tenant-id>/v2.0')
param authIssuerUrl string = ''

@description('Microsoft Entra Tenant ID (GUID) used when authMode is MicrosoftMIBasedAuth.')
param authTenantId string = ''

@description('Optional array of allowed client application IDs. If empty, all applications in the tenant are allowed (not recommended for production).')
param authAllowedClientApps array = []

@secure()
@description('MongoDB X.509 connection string. MUST be authMechanism=MONGODB-X509, authSource=$external, tls=true, and tlsCertificateKeyFile pointing at the mounted cert path (default /certs/client.pem). Username/password is rejected by the server.')
param mdbConnectionString string

@secure()
@description('Contents of the X.509 client certificate PEM (private key + cert). Mounted into the container as a secret volume at /certs/client.pem.')
param x509CertificatePem string

@description('Name of the app-layer shared-secret HTTP header the MCP server requires on every request (defense in depth alongside the Entra edge check). The value is supplied separately via sharedSecretValue. Foundry must send this header via its project connection.')
param authHeaderName string = 'x-mcp-key'

@secure()
@description('Value of the app-layer shared-secret header. Generate a strong random value. Required: httpAuthMode=platform refuses to start without a shared-secret header.')
param sharedSecretValue string

var useExistingContainerAppEnvironment = !empty(containerAppEnvironmentName)

// Reuse an existing ACA environment when one is supplied.
resource existingContainerAppEnv 'Microsoft.App/managedEnvironments@2024-02-02-preview' existing = if (useExistingContainerAppEnvironment) {
  name: containerAppEnvironmentName
}

// Otherwise create a new ACA environment with a name that is stable per app.
resource containerAppEnv 'Microsoft.App/managedEnvironments@2024-02-02-preview' = if (!useExistingContainerAppEnvironment) {
  name: 'mcp-env-${uniqueString(resourceGroup().id, containerAppName)}'
  location: location
  properties: {}
}

var envResourceId = useExistingContainerAppEnvironment ? existingContainerAppEnv.id : containerAppEnv.id

// The MCP server's runtime configuration. httpAuthMode=platform tells the
// server that identity is verified upstream (ACA EasyAuth / Entra); it still
// enforces the shared-secret header below so it never serves an
// unauthenticated request (OWASP MCP07, defense in depth).
var baseEnvVars = [
  {
    name: 'MDB_MCP_TRANSPORT'
    value: 'http'
  }
  {
    name: 'MDB_MCP_HTTP_HOST'
    value: '0.0.0.0'
  }
  {
    name: 'MDB_MCP_HTTP_PORT'
    value: string(httpPort)
  }
  {
    name: 'MDB_MCP_HTTP_AUTH_MODE'
    value: 'platform'
  }
  {
    name: 'MDB_MCP_LOGGERS'
    value: 'stderr,mcp'
  }
  {
    name: 'MDB_MCP_READ_ONLY'
    value: string(readOnly)
  }
]

// Secrets stored in the Container App. The shared-secret header is supplied to
// the server as a JSON object via MDB_MCP_HTTP_HEADERS so the secret value is
// never an inline env value.
var httpHeadersJson = '{"${authHeaderName}":"${sharedSecretValue}"}'

var containerAppSecrets = [
  {
    name: 'mdb-mcp-connection-string'
    value: mdbConnectionString
  }
  {
    name: 'mcp-http-headers'
    value: httpHeadersJson
  }
  {
    name: 'mdb-x509-cert'
    value: x509CertificatePem
  }
]

var secretEnvVars = [
  {
    name: 'MDB_MCP_CONNECTION_STRING'
    secretRef: 'mdb-mcp-connection-string'
  }
  {
    name: 'MDB_MCP_HTTP_HEADERS'
    secretRef: 'mcp-http-headers'
  }
]

var useUserAssignedAcrPull = !empty(acrPullIdentityResourceId)

// Registry pull identity: a pre-created user-assigned identity (first-deploy
// safe) when provided, otherwise the app's system-assigned identity.
var registries = empty(acrLoginServer) ? [] : [
  {
    server: acrLoginServer
    identity: useUserAssignedAcrPull ? acrPullIdentityResourceId : 'system'
  }
]

var appIdentity = useUserAssignedAcrPull ? {
  type: 'SystemAssigned, UserAssigned'
  userAssignedIdentities: {
    '${acrPullIdentityResourceId}': {}
  }
} : {
  type: 'SystemAssigned'
}

// Deploy Container App
resource containerApp 'Microsoft.App/containerApps@2024-02-02-preview' = {
  name: containerAppName
  location: location
  identity: appIdentity
  properties: {
    managedEnvironmentId: envResourceId
    configuration: {
      ingress: {
        external: true
        targetPort: httpPort
        transport: 'auto'
      }
      secrets: containerAppSecrets
      registries: registries
    }
    template: {
      volumes: [
        {
          name: 'certs'
          storageType: 'Secret'
          secrets: [
            {
              secretRef: 'mdb-x509-cert'
              path: 'client.pem'
            }
          ]
        }
      ]
      containers: [
        {
          name: 'mcpserver'
          image: containerImage
          resources: {
            cpu: containerCpuNumber
            memory: containerMemory
          }
          env: concat(baseEnvVars, secretEnvVars)
          volumeMounts: [
            {
              volumeName: 'certs'
              mountPath: '/certs'
            }
          ]
        }
      ]
      // Pinned to a single replica: MCP Streamable HTTP holds per-session
      // state, so requests for a session must hit the same replica. To scale
      // out, switch the server to stateless mode (httpResponseType=json +
      // externallyManagedSessions=true) and raise these.
      scale: {
        minReplicas: 1
        maxReplicas: 1
        rules: []
      }
    }
  }
}

// Container App edge authentication (EasyAuth / Microsoft Entra). Validates
// the caller's Entra token (Foundry Project Managed Identity, audience =
// authClientId) and returns 401 before the request reaches the container.
resource containerAppAuth 'Microsoft.App/containerApps/authConfigs@2024-10-02-preview' = if (authMode == 'MicrosoftMIBasedAuth') {
  name: 'current'
  parent: containerApp
  properties: {
    platform: {
      enabled: true
    }
    globalValidation: {
      unauthenticatedClientAction: 'Return401'
      redirectToProvider: 'azureActiveDirectory'
    }
    identityProviders: {
      azureActiveDirectory: {
        enabled: true
        registration: {
          clientId: authClientId
          openIdIssuer: authIssuerUrl
        }
        validation: {
          allowedAudiences: [
            authClientId
          ]
          defaultAuthorizationPolicy: length(authAllowedClientApps) > 0 ? {
            allowedApplications: authAllowedClientApps
          } : null
          jwtClaimChecks: length(authAllowedClientApps) > 0 ? {
            allowedClientApplications: authAllowedClientApps
          } : null
        }
      }
    }
  }
}

output containerAppUrl string = 'https://${containerApp.properties.configuration.ingress.fqdn}/mcp'
output containerAppPrincipalId string = containerApp.identity.principalId
output managedEnvironmentName string = useExistingContainerAppEnvironment ? existingContainerAppEnv.name : containerAppEnv.name
@description('Tenant ID param is surfaced for reference; EasyAuth issuer carries the tenant.')
output authTenantIdEcho string = authTenantId
