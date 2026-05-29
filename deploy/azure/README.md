# Host the hardened MongoDB MCP Server on Azure Container Apps (for Foundry agents)

This deploys the **hardened** MongoDB MCP Server (this branch: X.509-only
MongoDB auth, no delete tools, OWASP MCP Top 10 mitigations) to **Azure
Container Apps (ACA)** with a public HTTPS endpoint that **Microsoft Foundry
hosted agents** can connect to via the MCP tool.

## Authentication model (two independent layers)

```
Foundry agent ──HTTPS──▶ ACA ingress ──▶ EasyAuth (Microsoft Entra)  ──▶ MCP container
                                          │ validates the caller's        │ requires the
                                          │ Entra token (audience =        │ shared-secret
                                          │ app client ID); 401 if bad     │ header (403 if
                                          ▼                                ▼ missing/wrong)
                                   edge identity layer            app-layer secret layer
```

- **Edge (ACA EasyAuth / Microsoft Entra):** Foundry connects using its
  **Project Managed Identity**, requesting a token whose audience is the MCP
  server's Entra **app client ID**. ACA validates it and returns `401` before
  the request reaches the container.
- **App (`httpAuthMode=platform` + shared-secret header):** the server is told
  identity is verified upstream, but it still **rejects any request lacking the
  shared-secret header** (`x-mcp-key` by default). This keeps OWASP **MCP07**
  enforced *in the app itself* — it never serves an unauthenticated request.

Both layers are required at deploy time: the bicep refuses to omit the shared
secret, and `authMode=MicrosoftMIBasedAuth` wires the Entra edge.

> The server connects to MongoDB Atlas using **X.509 client-certificate** auth
> only (username/password is rejected). The PEM is mounted as a secret volume.

## Prerequisites

- Azure CLI ≥ 2.55 (`az login`) with rights to deploy ACA + role assignments.
- An **Azure Container Registry (ACR)** (private) to hold the image.
- A **Microsoft Entra app registration** to represent the MCP server (gives you
  the **app client ID**, **tenant ID**, **issuer URL**). See
  <https://learn.microsoft.com/azure/container-apps/authentication-entra> →
  "Option 2: Use an existing registration created separately".
- A **MongoDB Atlas X.509** database user, its **client certificate PEM**, and
  the matching **X.509 connection string**.
- A Foundry project to register the tool in.

## Step 1 — Build and push the image

The image is built **from this source branch** (not the published npm package)
via `deploy/azure/Dockerfile`. Run from the repo root:

```bash
ACR=myregistry                      # your ACR name (without .azurecr.io)
az acr login --name "$ACR"
docker build -f deploy/azure/Dockerfile -t "$ACR.azurecr.io/mongodb-mcp-server:hardened" .
docker push "$ACR.azurecr.io/mongodb-mcp-server:hardened"
```

## Step 2 — Identity for the private image pull (recommended)

A system-assigned identity can't pull on the *first* deploy (it doesn't exist
yet). Pre-create a **user-assigned identity** and grant it `AcrPull`:

```bash
RG=mongodb-mcp-rg
az group create -n "$RG" -l eastus
az identity create -g "$RG" -n mcp-acr-pull
PRINCIPAL=$(az identity show -g "$RG" -n mcp-acr-pull --query principalId -o tsv)
UAMI_ID=$(az identity show -g "$RG" -n mcp-acr-pull --query id -o tsv)
ACR_ID=$(az acr show -n "$ACR" --query id -o tsv)
az role assignment create --assignee "$PRINCIPAL" --role AcrPull --scope "$ACR_ID"
# pass $UAMI_ID as acrPullIdentityResourceId below
```

(Alternative: omit `acrPullIdentityResourceId`, deploy once, grant `AcrPull` to
the `containerAppPrincipalId` output, then redeploy.)

## Step 3 — Prepare parameters

Copy a template (drop the `_template` suffix) and fill the non-secret values:

```bash
cp bicep/paramsWithAuthEnabled_template.json bicep/paramsWithAuthEnabled.json
```

Set `containerImage`, `acrLoginServer`, `acrPullIdentityResourceId`,
`authClientId`, `authIssuerUrl`, `authTenantId` (and optionally
`authAllowedClientApps`). **Leave secrets as placeholders** — pass them at
deploy time so they never land in source control.

The **connection string** must be X.509 and point at the mounted cert path
(`/certs/client.pem`):

```
mongodb+srv://<cluster>.mongodb.net/?authSource=%24external&authMechanism=MONGODB-X509&tls=true&tlsCertificateKeyFile=/certs/client.pem
```

## Step 4 — Deploy

```bash
CS='mongodb+srv://...tlsCertificateKeyFile=/certs/client.pem'   # X.509 only
KEY=$(openssl rand -hex 32)                                     # shared-secret header value

az deployment group create \
  -g "$RG" \
  --template-file bicep/main.bicep \
  --parameters @bicep/paramsWithAuthEnabled.json \
  --parameters \
      acrPullIdentityResourceId="$UAMI_ID" \
      mdbConnectionString="$CS" \
      x509CertificatePem="$(cat client.pem)" \
      sharedSecretValue="$KEY"
```

Note the outputs: `containerAppUrl` (ends in `/mcp`) and
`containerAppPrincipalId`. Save `$KEY` — Foundry needs it.

## Step 5 — Verify

```bash
URL=$(az deployment group show -g "$RG" -n main --query properties.outputs.containerAppUrl.value -o tsv)
# Unauthenticated request should be 401 (EasyAuth) — never 200:
curl -s -o /dev/null -w "%{http_code}\n" "$URL"      # expect 401
```

A `200`/`426` here means EasyAuth isn't enforcing — stop and fix before
connecting Foundry.

## Step 6 — Register the tool in Foundry

In the Foundry portal, add an MCP tool / connection:

- **Server URL:** the `containerAppUrl` output (`https://<app>.<region>.azurecontainerapps.io/mcp`)
- **Authentication:** *Microsoft Entra*
- **Type:** *Project Managed Identity*
- **Audience:** the MCP server's Entra **app client ID** (`authClientId`)
- **Custom header:** `x-mcp-key: <the $KEY value>` (the app-layer shared secret)
- **Approval:** keep `require_approval` on for write/create tools.

> **Verify both credentials ride together (the one open question):** Foundry must
> send the `x-mcp-key` header *alongside* its managed-identity `Authorization`
> token. If the platform sends only one, you'll see `401` (EasyAuth) or `403`
> (missing header). Fallbacks: move the secret to a header EasyAuth tolerates,
> or set `authMode` so the gateway alone gates (the app still requires the
> header — adjust per your policy).

## Notes

- **Tools available:** this build has **no delete tools** (drop/delete are
  compiled out and cannot be re-enabled by config). `readOnly=false` allows
  create/update; set `readOnly=true` for read + metadata only.
- **Scaling:** pinned to a single replica because MCP Streamable HTTP holds
  per-session state. To scale out, switch the server to stateless mode
  (`MDB_MCP_HTTP_RESPONSE_TYPE=json` + `MDB_MCP_EXTERNALLY_MANAGED_SESSIONS=true`)
  and raise `min/maxReplicas`.
- **Cert rotation:** update the `mdb-x509-cert` secret (redeploy with a new
  `x509CertificatePem`); the driver picks up the remounted file on restart.
- **Secrets:** never commit real `mdbConnectionString`, `x509CertificatePem`,
  or `sharedSecretValue`. Pass them via `--parameters` overrides or Key Vault
  references.

## Cleanup

```bash
az group delete --name "$RG" --yes --no-wait
```
