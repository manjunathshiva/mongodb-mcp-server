# Host the hardened MongoDB MCP Server on Azure Container Apps (for Foundry agents)

This deploys the **hardened** MongoDB MCP Server (this branch: X.509-only
MongoDB auth, no delete tools, OWASP MCP Top 10 mitigations) to **Azure
Container Apps (ACA)** with a public HTTPS endpoint that **Microsoft Foundry
hosted agents** can connect to via the MCP tool.

## Authentication model

The server always enforces an **app-layer shared-secret header** (`x-mcp-key`
by default; `httpAuthMode=platform` refuses to start without one). On top of
that you can optionally add a **Microsoft Entra edge layer** via ACA EasyAuth.
That gives two supported modes:

**Mode 1 — Entra + shared secret (recommended for production)** —
`authMode=MicrosoftMIBasedAuth`:

```
Foundry agent ──HTTPS──▶ ACA ingress ──▶ EasyAuth (Microsoft Entra)  ──▶ MCP container
                                          │ validates the caller's        │ requires the
                                          │ Entra token (audience =        │ shared-secret
                                          │ app client ID); 401 if bad     │ header (403 if
                                          ▼                                ▼ missing/wrong)
                                   edge identity layer            app-layer secret layer
```

- **Edge:** Foundry connects with its **Project Managed Identity**; ACA
  EasyAuth validates the Entra token (audience = the app client ID) and returns
  `401` before the request reaches the container.
- **App:** the server still **rejects any request lacking the shared-secret
  header**, so it never serves an unauthenticated request (OWASP **MCP07**).
- Requires a **Microsoft Entra app registration** (often tenant-admin-gated).

**Mode 2 — shared secret only (no Entra)** — `authMode=NOAUTH`:

```
Foundry agent ──HTTPS──▶ ACA ingress ──▶ MCP container
                                          │ requires the shared-secret
                                          ▼ header (403 if missing/wrong)
                                   app-layer secret layer (only gate)
```

- The public endpoint is gated **only** by the static `x-mcp-key` header.
- Use this when you can't create an Entra app registration (e.g. the tenant
  blocks self-service registration). It's weaker — the header is the sole gate,
  so **rotate it regularly** and prefer Mode 1 once an app registration is
  available. Foundry connects via **Key-based** authentication (see Step 6).

> Regardless of mode, the server connects to MongoDB Atlas using **X.509
> client-certificate** auth only (username/password is rejected). The PEM is
> mounted as a secret volume.

## Prerequisites

- Azure CLI ≥ 2.55 (`az login`) with rights to deploy ACA + role assignments.
- An **Azure Container Registry (ACR)** (private) to hold the image.
- **Mode 1 only:** a **Microsoft Entra app registration** to represent the MCP
  server (gives you the **app client ID**, **tenant ID**, **issuer URL**). See
  <https://learn.microsoft.com/azure/container-apps/authentication-entra> →
  "Option 2: Use an existing registration created separately". If your tenant
  blocks self-service app registration (portal "you don't have access", or
  `az ad` fails), ask a tenant admin — or use **Mode 2** (no registration).
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
# Mode 1 (Entra):
cp bicep/paramsWithAuthEnabled_template.json bicep/paramsWithAuthEnabled.json
# Mode 2 (key-only, no Entra):
cp bicep/params_template.json bicep/params.json
```

- **Mode 1:** set `containerImage`, `acrLoginServer`,
  `acrPullIdentityResourceId`, `authClientId`, `authIssuerUrl`, `authTenantId`
  (and optionally `authAllowedClientApps`).
- **Mode 2:** set `containerImage`, `acrLoginServer`,
  `acrPullIdentityResourceId`; leave `authMode=NOAUTH` (the auth* params are
  unused).

**Leave secrets as placeholders** — pass them at deploy time so they never land
in source control.

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

(Mode 2: use `@bicep/params.json` instead of `@bicep/paramsWithAuthEnabled.json`.)

> **Windows/PowerShell tip:** passing `mdbConnectionString` and
> `x509CertificatePem` inline breaks the shell — the connection string's `&`
> is treated as a command separator and the multi-line PEM truncates the
> command. Build a parameters JSON file instead (PEM read with
> `[System.IO.File]::ReadAllText`, values as plain JSON strings) and pass
> `--parameters "@params.json"`. Verify the file is a few KB (not ~1 MB — a
> sign `ConvertTo-Json` mangled the PEM into an object) before deploying.

Note the outputs: `containerAppUrl` (ends in `/mcp`) and
`containerAppPrincipalId`. Save `$KEY` — Foundry needs it.

## Step 5 — Verify

```bash
URL=$(az deployment group show -g "$RG" -n <deployment-name> --query properties.outputs.containerAppUrl.value -o tsv)

# No credentials -> blocked (never 200):
#   Mode 1 (Entra): 401 at the EasyAuth edge.   Mode 2 (key-only): 403 at the app gate.
curl -s -o /dev/null -w "%{http_code}\n" "$URL"

# Mode 2: with the shared-secret header the gate passes; a bare GET then returns
# 400 ("session id required") from the MCP layer — i.e. NOT 403:
curl -s -o /dev/null -w "%{http_code}\n" -H "x-mcp-key: $KEY" "$URL"   # expect 400
```

A `200` with no credentials means nothing is enforcing — stop and fix before
connecting Foundry.

## Step 6 — Register the tool in Foundry

In the Foundry portal, **Add Tools → connect the MongoDB MCP Server tool**, set
the **Remote MCP Server endpoint** to the `containerAppUrl` output
(`https://<app>.<region>.azurecontainerapps.io/mcp`), then pick the path that
matches your deploy mode:

### Mode 1 — Microsoft Entra (production)

- **Authentication:** *Microsoft Entra*
- **Type:** *Project Managed Identity*
- **Audience:** the MCP server's Entra **app client ID** (`authClientId`)
- Plus the app-layer header: `x-mcp-key` = the `sharedSecretValue` you deployed.
- **Approval:** keep `require_approval` on for write/create tools.

> Foundry must send the `x-mcp-key` header *alongside* its managed-identity
> token. If only one is sent you'll see `401` (edge) or `403` (app). Fallback:
> use Mode 2, or move the secret to a header EasyAuth tolerates.

### Mode 2 — Key-based (no Entra) — validated

The "Connect the MongoDB MCP Server tool" dialog with **Authentication:
Key-based** takes a credential key/value pair that becomes an HTTP header:

- **Authentication:** *Key-based*
- **Credential key:** `x-mcp-key`
- **Credential value:** the `sharedSecretValue` you deployed (the `$KEY`)
- **Approval:** keep `require_approval` on for write/create tools.

Click **Connect**. Foundry stores it as a project connection and sends
`x-mcp-key: <value>` on every request, which passes the app gate. Confirmed
working end-to-end: an agent calling `list-databases` returns live Atlas data.

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
