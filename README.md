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
PUBLIC_BASE_URL=http://localhost:5000
```

`BETTER_AUTH_SECRET` is used to verify the HMAC identity headers that the Next.js
app sends. Every protected route re-checks the caller's role and status in
MongoDB, and checks resource ownership.

## Endpoints

| Area          | Routes                                                                 |
| ------------- | ---------------------------------------------------------------------- |
| Health        | `GET /`, `GET /health`                                                 |
| Users         | `GET /users`, `GET /users/:id` (admin)                                 |
| Candidates    | `GET /candidates` (recruiter/admin)                                    |
| Jobs          | `GET /jobs`, `GET /jobs/recommended`, `GET/PATCH/DELETE /jobs/:id`, `POST /jobs` |
| Applications  | `GET/POST /applications`, `GET/PATCH/DELETE /applications/:id`          |
| Saved jobs    | `GET/POST /saved-jobs`, `DELETE /saved-jobs/:jobId`                    |
| Interviews    | `GET/POST /interviews`, `GET/PATCH/DELETE /interviews/:id`             |
| Notifications | `GET /notifications`, `PATCH /notifications/:id/read`, `PATCH /notifications/read-all`, `DELETE /notifications/:id` |
| Profiles      | `GET/PUT /profiles/me`, `POST/DELETE /profiles/me/resume`, `GET /profiles/:id` |
| Companies     | `GET /companies`, `GET/PUT/DELETE /companies/me`                       |
| Admin         | `GET /admin/stats`, `GET /admin/analytics`, `GET /admin/users/:id`, `GET/POST /admin/reports`, `GET/PATCH/DELETE /admin/reports/:id` |

Resumes are stored in `uploads/` and served from `/uploads/<file>`. Uploads are
limited to PDF/DOC/DOCX files up to 5 MB.

Account creation, role changes, suspension, and account deletion stay in the
Next.js app because Better Auth owns those records.
