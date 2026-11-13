# HireLoop API

Express + MongoDB API for the HireLoop Next.js client. The whole server is in
[`index.js`](./index.js).

## Setup

```bash
npm install
npm run dev   # nodemon
npm start     # production
```

`.env` (never commit this file):

```dotenv
PORT=5000
MONGO_DB_URI=mongodb://...
MONGO_DB_NAME=hireloopdb
BETTER_AUTH_SECRET=same-secret-as-the-next-app
CORS_ORIGINS=http://localhost:3000
```

`BETTER_AUTH_SECRET` verifies the HMAC identity headers (`x-hireloop-user-id`,
`x-hireloop-user-role`, `x-hireloop-timestamp`, `x-hireloop-signature`) sent by
the Next.js app. Every protected route re-checks the caller's role and status in
MongoDB.

## Endpoints

Collections use one generic CRUD helper. `GET` list routes accept `?limit=`,
`?skip=` and equality filters for that collection's fields.

| Area          | Routes                                                                 |
| ------------- | ---------------------------------------------------------------------- |
| Health        | `GET /`, `GET /health`                                                 |
| Users         | `GET /users`, `GET /users/:id` (admin; Better Auth owns writes)        |
| Jobs          | `GET/POST /jobs`, `GET/PATCH/PUT/DELETE /jobs/:id`                     |
| Applications  | `GET/POST /applications`, `GET/PATCH/PUT/DELETE /applications/:id`      |
| Saved jobs    | `GET/POST /saved-jobs`, `GET/DELETE /saved-jobs/:id`                   |
| Interviews    | `GET/POST /interviews`, `GET/PATCH/PUT/DELETE /interviews/:id`         |
| Notifications | `GET/POST /notifications`, `PATCH/PUT/DELETE /notifications/:id`, `PATCH /notifications/read-all` |
| Profiles      | `GET/PUT/PATCH /profiles/me` (one profile per user)                    |
| Companies     | `GET /companies` (admin), `GET/PUT/PATCH/DELETE /companies/me`         |
| Reports       | `GET/POST /reports`, `GET/PATCH/PUT/DELETE /reports/:id`               |

Write permissions and ownership scoping:

- Jobs: recruiters/admins write; recruiters only their own jobs; seekers see active jobs only.
- Applications: seekers apply; seekers see their own, recruiters see applications for their jobs.
- Interviews: recruiters/admins write; seekers see their own interviews.
- Notifications and saved jobs: scoped to the calling user.
- Reports: anyone can report; only admins update/delete.
- Profiles and companies are upserted through `/me`.

`DELETE /saved-jobs/:id` takes the saved-job document id (not the job id).
There is no resume upload endpoint; store `resumeUrl` through `PATCH /profiles/me`.
Account creation, role changes, suspension and deletion stay in the Next.js app
because Better Auth owns those records.
