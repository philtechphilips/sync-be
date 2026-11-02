# Tests

```bash
npm test            # unit tests (no database needed)
npm run test:e2e    # skipped unless SYNQ_E2E=1
```

The end-to-end suites boot the whole API against throwaway databases in
Docker. They never read your `.env` (see `test/env.setup.ts`), so they can't
touch a real database.

```bash
docker run -d --name synq-test-mysql -e MYSQL_ROOT_PASSWORD=testpass -e MYSQL_DATABASE=testdb -p 33306:3306 mysql:8.0
docker run -d --name synq-test-pg -e POSTGRES_PASSWORD=testpass -e POSTGRES_DB=testdb -p 35432:5432 postgres:16
docker run -d --name synq-test-mssql --platform linux/amd64 -e ACCEPT_EULA=Y -e MSSQL_SA_PASSWORD='Test_pass123' -p 31433:1433 mcr.microsoft.com/mssql/server:2022-latest
docker run -d --name synq-test-redis -p 36379:6379 redis:7-alpine
docker run -d --name synq-test-mail -e MP_SMTP_AUTH_ACCEPT_ANY=1 -e MP_SMTP_AUTH_ALLOW_INSECURE=1 -p 31025:1025 -p 38025:8025 axllent/mailpit:v1.21

SYNQ_E2E=1 npm run test:e2e
SYNQ_E2E=1 SYNQ_E2E_MSSQL=0 npm run test:e2e   # skip SQL Server
```

| Suite                        | Covers                                                             |
| ---------------------------- | ------------------------------------------------------------------ |
| `clusters.e2e-spec.ts`       | auth hardening, encrypted credentials, typed values, backups, sync |
| `schemas.e2e-spec.ts`        | non-default schemas, indexes and foreign keys across engines       |
| `agent.e2e-spec.ts`          | the real `../synqdb-agent` process, saved connections              |
| `multi-instance.e2e-spec.ts` | two API instances sharing Redis                                    |
| `auth-flows.e2e-spec.ts`     | reset emails (via Mailpit) and Google sign-in (Google stubbed)     |

The agent suites start the real `../synqdb-agent` process, so run
`npm install` in that folder first. Remove the containers afterwards with
`docker rm -f synq-test-mysql synq-test-pg synq-test-mssql synq-test-redis synq-test-mail`.
