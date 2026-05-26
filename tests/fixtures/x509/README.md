# Test X.509 fixtures

Static self-signed CA + server + client certificates used by the integration
test suite to exercise the X.509-only auth policy against a real mongod.

These certs **are not secrets** in any meaningful sense: the CA is self-signed
and chains to nothing real, so the only systems that ever trust them are the
ephemeral mongods spun up by the test runner. They are committed to the repo
so test runs are reproducible without code-time cert generation, and so CI
doesn't depend on openssl being on PATH.

## Files

- `ca.crt` / `ca.key` — self-signed CA. mongod is told to trust this CA so it
  will accept client certificates signed by it; tests use the same CA to
  validate the server's TLS cert.
- `server.crt` / `server.key` / `server.pem` — server cert signed by the CA,
  CN = `localhost`, SAN includes `localhost` + `127.0.0.1`. Used by mongod's
  `--tlsCertificateKeyFile`. `server.pem` is the concatenated key + cert
  required by mongod.
- `client.crt` / `client.key` / `client.pem` — client cert signed by the CA,
  CN = `mongodb-mcp-test-client`. The X.509 user created in `$external` has
  the exact subject `CN=mongodb-mcp-test-client,OU=test-client,O=mongodb-mcp-test,C=US`
  so connections presenting this cert authenticate as that user.

## Regenerating (only when the certs expire — 10 years from generation)

Run from this directory with openssl ≥ 1.1.1 available:

```bash
openssl genpkey -algorithm RSA -out ca.key -pkeyopt rsa_keygen_bits:2048
openssl req -x509 -new -key ca.key -days 3650 \
  -subj "/C=US/O=mongodb-mcp-test/OU=test-ca/CN=mongodb-mcp-test-ca" -out ca.crt

openssl genpkey -algorithm RSA -out server.key -pkeyopt rsa_keygen_bits:2048
openssl req -new -key server.key \
  -subj "/C=US/O=mongodb-mcp-test/OU=test-server/CN=localhost" -out server.csr
printf "subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n" > server.ext
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -days 3650 -extfile server.ext -out server.crt
cat server.key server.crt > server.pem

openssl genpkey -algorithm RSA -out client.key -pkeyopt rsa_keygen_bits:2048
openssl req -new -key client.key \
  -subj "/C=US/O=mongodb-mcp-test/OU=test-client/CN=mongodb-mcp-test-client" -out client.csr
printf "extendedKeyUsage=clientAuth\n" > client.ext
openssl x509 -req -in client.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -days 3650 -extfile client.ext -out client.crt
cat client.key client.crt > client.pem

rm -f server.csr server.ext client.csr client.ext ca.srl
```

## Client subject DN (for `createUser` in `$external`)

```
CN=mongodb-mcp-test-client,OU=test-client,O=mongodb-mcp-test,C=US
```
