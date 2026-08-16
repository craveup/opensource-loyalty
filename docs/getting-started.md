# Getting started

This is the shortest path from a clean clone to a working loyalty request.

## 1. Start the sandbox

If you just want to try the project, use Docker:

```sh
git clone https://github.com/craveup/opensource-loyalty.git
cd opensource-loyalty
docker compose up --build
```

If you want to develop against the source code, use Node.js 22 or newer and
npm. The repo uses npm workspaces with `package-lock.json`; pnpm is not the
supported install path unless the project is intentionally migrated later.

```sh
git clone https://github.com/craveup/opensource-loyalty.git
cd opensource-loyalty
npm install
npm start
```

Use `npm ci` instead of `npm install` when you want a clean install that follows
the lockfile exactly.

Keep that terminal open. It prints the Admin URL and Admin/API key:

```text
Admin: http://127.0.0.1:3210/admin/
Admin/API key: lip-dev-key
```

The same key is used for dashboard sign-in and Bearer API requests. If you
started with Docker and need to see the key again, run:

```sh
docker compose logs lip
```

The local sandbox API runs at:

```text
http://127.0.0.1:3210
```

## 2. Check that it works

In a second terminal:

```sh
npm run lip -- doctor http://127.0.0.1:3210 --api-key lip-dev-key
npm run lip -- test http://127.0.0.1:3210 --api-key lip-dev-key
```

If you are using Docker without local Node dependencies installed, use curl:

```sh
curl http://127.0.0.1:3210/health
curl http://127.0.0.1:3210/lip/v1/capabilities \
  -H 'Authorization: Bearer lip-dev-key'
```

## 3. Run the full loyalty flow

```sh
npm run example:sdk
```

This runs the happy path end to end:

```text
enroll member
  -> evaluate order
  -> post accrual
  -> reserve reward
  -> capture reward
  -> reverse reward
  -> adjust refunded order
```

## 4. Use the SDK in an app

```ts
import { LipClient } from "@loyalty-interchange/sdk";

const lip = new LipClient({
  baseUrl: "http://127.0.0.1:3210",
  apiKey: "lip-dev-key",
  source: { system: "my-ordering-app", instance: "local" }
});

const capabilities = await lip.capabilities();
```

The SDK creates request ids, timestamps, idempotency keys, and protocol context
for application calls.

## 5. Know where to go next

- [API endpoints](api-endpoints.md): current HTTP routes and curl examples.
- [TypeScript SDK](typescript-sdk.md): SDK operations, errors, money helpers,
  order builder, and webhook verification.
- [Five-minute quickstart](quickstart.md): more CLI checks, validation, Docker,
  reset, and seed controls.
- [Reference platform](reference-platform.md): server, Admin dashboard, storage,
  and non-normative boundaries.

You should not need the normative specification for the first successful local
request. Use `spec/` when you are implementing a provider, writing an adapter,
or validating conformance.
