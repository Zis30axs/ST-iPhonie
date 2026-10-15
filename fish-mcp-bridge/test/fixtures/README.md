# Local test fixtures only

`localhost-test.key` and `.crt` are deliberately public, self-signed test TLS credentials for localhost only. Do not deploy them. Tests trust the certificate only in a spawned test subprocess, using NODE_EXTRA_CA_CERTS. Runtime TLS verification is unchanged.

`upstream-network.mjs` contains function-level fixtures derived from ST-iPhonie commit 5be4cd1e388acccc17bb3a3ae0c6503e71799286. These are not full upstream files. Verified source blob IDs: novelai.js e02414b4b3660b4eae95e380bcb09dbc6dde209b; image-engines.js 3e5ca2ea4e9038f853c2f102547eb43d34749eb9; cloud-queue.js 1900e22aafe0dce3e01a6a3cb24d85d7de6846c6. music.js playable declaration was read through GitHub code search for the same commit.
