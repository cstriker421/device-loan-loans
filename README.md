# Device Loan: Loan Service

The **Loan Service** of the Campus Device Loan Program (Cloud Native DevOps assignment).
It owns device stock and loans: a student reserves a device of a given model, and the service
makes sure two students can never get the same physical device. It is one container in the
C4 Container diagram, with its own database and its own Function App.

## At a Glance

| | |
|---|---|
| C4 container | Loan Service, with the Loans DB |
| Technology | Azure Functions v4, Node.js 22, TypeScript, Cosmos DB for NoSQL (serverless) |
| Endpoints | `POST /api/loans` (reserve), `GET /api/health` |
| Tests | **45 automated tests**, run with `npm test`, no Azure needed |
| Sibling repositories | [`device-loan-catalogue`](https://github.com/cstriker421/device-loan-catalogue) (Catalogue Service). Web app and notification repositories are planned |
| Status | Reserve is built and verified against real Cosmos DB (dev). Not yet deployed to test (see Status). |

## Quick Start for a Review

```bash
npm ci
npm test            # builds, then runs 45 tests with Node's built-in runner
```

The tests use in-memory fakes, so no database or account is needed. They cover the domain rules,
the Cosmos adapters against a stand-in container, the reserve use case, and the HTTP layer.

## API

### `POST /api/loans`: reserve a device

Headers: `Idempotency-Key` (8 to 64 characters), `x-student-id` (**temporary**, see Security notes).
Body: `{ "modelId": "dm-001" }`

```bash
curl -i -X POST http://localhost:7071/api/loans \
  -H "Content-Type: application/json" \
  -H "x-student-id: auth0|alice" -H "Idempotency-Key: key-alice-0001" \
  -d '{"modelId":"dm-001"}'
```

| Status | Meaning |
|---|---|
| `201` | Reserved. Body: `{ "loan": { id, deviceId, modelId, studentId, idempotencyKey, status: "reserved", reservedAt, dueAt } }`. `dueAt` is exactly 48 hours after `reservedAt` |
| `200` | The same `Idempotency-Key` was used before: the original loan is returned and nothing new is created |
| `409` | `no_unit_available`: no device of that model could be secured |
| `400` | `invalid_request` with an `issues` list naming every problem |
| `500` | `internal_error`: a safe message only. The real cause is in the logs |

### `GET /api/health`

Returns `{"status":"ok","service":"loan-service"}`.

## How the Code is Organised

Ports and adapters. Dependencies point inwards, and only `config` chooses adapters.

| Folder | Layer | What is in it |
|---|---|---|
| `src/domain` | Domain | `Device` and `Loan` with their status rules, validation and 48-hour due date (`device.ts`, `loan.ts`). Repository ports, error types, and `restore.ts` which re-validates stored data. No I/O, no Azure imports |
| `src/app` | Application | `reserve-loan.ts` (the use case) and `logger.ts` (a logging port) |
| `src/infra` | Infrastructure | Cosmos adapters for devices and loans, with separate stored-document types |
| `src/http` | HTTP edge | `reserve-loan-handler.ts` maps outcomes to status codes. `function-logger.ts` writes structured logs. Kept outside `src/functions` so it can be tested |
| `src/functions` | Entry points | The Azure Functions registrations: `reserve-loan-http.ts`, `health-http.ts` |
| `src/config` | Composition root | `appServices.ts` builds the repositories lazily from environment variables |
| `src/seed` | Tooling | Seeds 3 units for each of the 8 catalogue models (24 devices), safe to repeat |

## Concurrency and Idempotency

Reserving touches two Cosmos containers, so the service is built to be safe under contention:

- **No double booking.** A unit is claimed with an **ETag** check. If another request changed it first, the write is refused and the service tries the next unit. It re-reads up to three times, then answers `409`.
- **Safe retries.** `Idempotency-Key` plus a Cosmos **unique key** on `/idempotencyKey` (unique per student partition) means a repeated or double-submitted request creates one loan, never two.
- **Compensation.** If a unit is claimed but the loan cannot be saved, the unit is released again. If the release also fails, that is logged as an error (see Status).

Verified against real Cosmos in dev: six students competing for three units gave exactly three reservations, and five simultaneous requests with one key gave one loan.

## Data (Cosmos DB, database `loans-db`)

| Container | Partition key | Notes |
|---|---|---|
| `devices` | `/modelId` | One document per physical unit, with a status of available, reserved or on-loan |
| `loans` | `/studentId` | Unique key policy on `/idempotencyKey` (set at creation, cannot be added later) |

## Configuration

Environment variables only, with no defaults. A missing one fails with an error naming it.

| Variable | Meaning |
|---|---|
| `COSMOS_ENDPOINT` | Cosmos account endpoint |
| `COSMOS_DATABASE_ID` | `loans-db` |
| `COSMOS_DEVICES_CONTAINER_ID` | `devices` |
| `COSMOS_LOANS_CONTAINER_ID` | `loans` |
| `COSMOS_KEY` | Account key. Held in the shell or app settings. Never in a file or in git |

## Run It Against Your Own Cosmos Account

```bash
RG=<resource-group>; COSMOS=<account>; LOCATION=<region>
az group create --name $RG --location $LOCATION
az cosmosdb create --resource-group $RG --name $COSMOS --kind GlobalDocumentDB \
  --locations regionName=$LOCATION failoverPriority=0 isZoneRedundant=False \
  --capabilities EnableServerless --default-consistency-level Session
az cosmosdb sql database create -g $RG --account-name $COSMOS --name loans-db
az cosmosdb sql container create -g $RG --account-name $COSMOS --database-name loans-db \
  --name devices --partition-key-path '/modelId'
az cosmosdb sql container create -g $RG --account-name $COSMOS --database-name loans-db \
  --name loans --partition-key-path '/studentId' \
  --unique-key-policy '{"uniqueKeys":[{"paths":["/idempotencyKey"]}]}'

export COSMOS_KEY="$(az cosmosdb keys list -g $RG -n $COSMOS --type keys --query primaryMasterKey -o tsv)"
export COSMOS_ENDPOINT="$(az cosmosdb show -g $RG -n $COSMOS --query documentEndpoint -o tsv)"
export COSMOS_DATABASE_ID=loans-db COSMOS_DEVICES_CONTAINER_ID=devices COSMOS_LOANS_CONTAINER_ID=loans
npm run seed        # 24 device units
npm start           # http://localhost:7071
```

`npm start` also needs a `local.settings.json` containing `"FUNCTIONS_WORKER_RUNTIME": "node"` (git-ignored).

## Observability

One structured JSON log line per event, so each is a single row in Log Analytics. The use case logs
through a logging port, so business code has no dependency on Azure.

| Event | Level | Meaning |
|---|---|---|
| `repo.created` | info | Which Cosmos host, database and container this instance uses (never the key) |
| `loan.reserved` | info | A loan was created |
| `loan.reserve.replayed` | info | Idempotent retry returned the original loan |
| `loan.reserve.conflict` | warning | Another request took the unit first (ETag refused) |
| `loan.reserve.unavailable` | info | No unit of that model is free |
| `loan.reserve.contention` | warning | Heavy contention: three rounds of conflicts, so the request answered `409` |
| `loan.reserve.compensated` | info | A claimed unit was released again |
| `loan.reserve.compensation_failed` | **error** | A unit may be stuck reserved: needs attention |
| `http.loans.reserve` | info or warning | One summary per request: status, outcome, `durationMs` |
| `http.loans.reserve.failed` | error | Unexpected failure, with the cause. The caller gets a generic 500 |

## Status

- Built and verified: domain rules, ports, Cosmos adapters, reserve use case, `POST /api/loans`, `/api/health`, seed script, structured logging, 45 tests, live checks of concurrency and idempotency against Cosmos (dev).
- **Not yet done:** collect and return (staff), availability counts for the Catalogue Service, JWT validation and role checks with Auth0, Service Bus events, deployment to the test environment, CI/CD, `/ready`, correlation IDs.
- **Security notes:** the student identity is read from the `x-student-id` header only until Auth0 token validation is added, so it can be spoofed. Do not leave this service publicly deployed with that header.
- **Known limitation:** reserving writes two containers, which Cosmos cannot make atomic. If the process crashes between claiming a unit and saving the loan, the unit stays reserved with no loan. Ordinary failures are compensated, and a failed compensation is logged as an error. Reservation expiry or a reconciliation job would close the gap.