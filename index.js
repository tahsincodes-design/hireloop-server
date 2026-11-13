// HireLoop API — small generic CRUD server.
// Every collection gets GET / POST / PATCH / PUT / DELETE routes from one helper.
// Auth comes from the HMAC headers the Next.js app sends.

import "dotenv/config"
import { createHmac, timingSafeEqual } from "node:crypto"
import cors from "cors"
import express from "express"
import { MongoClient, ObjectId } from "mongodb"

const PORT = Number(process.env.PORT) || 5000
const MONGO_URI = process.env.MONGO_DB_URI
const DB_NAME = process.env.MONGO_DB_NAME ?? "hireloopdb"
if (!MONGO_URI) throw new Error("MONGO_DB_URI is missing.")

const client = new MongoClient(MONGO_URI)
await client.connect()
const db = client.db(DB_NAME)

const collections = {
  users: db.collection("user"),
  jobs: db.collection("job"),
  applications: db.collection("application"),
  profiles: db.collection("profile"),
  companies: db.collection("company"),
  savedJobs: db.collection("savedJob"),
  interviews: db.collection("interview"),
  notifications: db.collection("notification"),
  reports: db.collection("report"),
  payments: db.collection("payment"),
}

await Promise.all([
  collections.profiles.createIndex({ userId: 1 }, { unique: true }),
  collections.companies.createIndex({ ownerId: 1 }, { unique: true }),
  collections.savedJobs.createIndex({ userId: 1, jobId: 1 }, { unique: true }),
])

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ROLES = ["seeker", "recruiter", "admin"]

class HttpError extends Error {
  constructor(status, message, code) {
    super(message)
    this.status = status
    this.code = code
  }
}

const bad = (message, code = "INVALID_REQUEST") => {
  throw new HttpError(400, message, code)
}
const forbidden = (message) => {
  throw new HttpError(403, message, "FORBIDDEN")
}
const toObjectId = (value) => {
  const id = value instanceof ObjectId ? value : idString(value)
  return ObjectId.isValid(id) ? new ObjectId(id) : null
}
const idString = (value) => (value ? String(value) : null)
const withId = (doc) => {
  if (!doc) return null
  const { password, ...safe } = doc
  return { ...safe, _id: idString(doc._id), id: idString(doc._id) }
}
const pick = (body, fields) => {
  const out = {}
  for (const field of fields) {
    if (body?.[field] !== undefined) out[field] = body[field]
  }
  return out
}

async function mustFind(collection, id, label, filter = {}) {
  const objectId = toObjectId(id)
  if (!objectId) bad(`Invalid ${label} id.`, "INVALID_ID")
  const doc = await collection.findOne({ _id: objectId, ...filter })
  if (!doc) throw new HttpError(404, `${label} not found.`, "NOT_FOUND")
  return doc
}

// ---------------------------------------------------------------------------
// Auth (HMAC headers from the Next.js app)
// ---------------------------------------------------------------------------

const MAX_SKEW = 5 * 60 * 1000

function safeEqualHex(a, b) {
  if (typeof a !== "string" || !/^[a-f0-9]+$/i.test(a)) return false
  const left = Buffer.from(a, "hex")
  const right = Buffer.from(b, "hex")
  return left.length === right.length && timingSafeEqual(left, right)
}

async function verifyIdentity(req) {
  const id = req.get("x-hireloop-user-id")
  const role = req.get("x-hireloop-user-role")
  const timestamp = req.get("x-hireloop-timestamp")
  const signature = req.get("x-hireloop-signature")

  if (!id || !role || !timestamp || !signature) {
    throw new HttpError(401, "Missing identity headers.", "UNAUTHORIZED")
  }
  if (!ROLES.includes(role)) {
    throw new HttpError(401, "Invalid identity role.", "UNAUTHORIZED")
  }
  if (Math.abs(Date.now() - Number(timestamp)) > MAX_SKEW) {
    throw new HttpError(401, "Stale identity timestamp.", "UNAUTHORIZED")
  }

  const secret = process.env.BETTER_AUTH_SECRET
  if (!secret) {
    throw new HttpError(500, "BETTER_AUTH_SECRET is not configured.", "SERVER_MISCONFIGURED")
  }

  const expected = createHmac("sha256", secret)
    .update(`${id}.${role}.${timestamp}`)
    .digest("hex")
  if (!safeEqualHex(signature, expected)) {
    throw new HttpError(401, "Invalid identity signature.", "UNAUTHORIZED")
  }

  const user = await collections.users.findOne({ _id: toObjectId(id) })
  if (!user) throw new HttpError(401, "Unknown identity user.", "UNAUTHORIZED")
  if (user.status === "suspended") {
    throw new HttpError(403, "This account is suspended.", "ACCOUNT_SUSPENDED")
  }
  if (user.role !== role) {
    throw new HttpError(403, "Identity role is out of date.", "ROLE_MISMATCH")
  }

  return { id: idString(user._id), role, user }
}

const auth = (roles = ROLES) => async (req, res, next) => {
  try {
    const identity = await verifyIdentity(req)
    if (!roles.includes(identity.role)) {
      forbidden("You do not have permission to perform this action.")
    }
    req.identity = identity
    req.user = identity.user
    next()
  } catch (error) {
    next(error)
  }
}

const any = auth()

// ---------------------------------------------------------------------------
// Generic CRUD
// ---------------------------------------------------------------------------

function crud({
  path: route,
  collection,
  read = ROLES,
  create = [],
  update = [],
  remove = [],
  owner = null,
  fields = [],
  scope = () => ({}),
  guard = scope,
  beforeCreate,
  beforeUpdate,
  afterCreate,
}) {
  const visible = (req) => scope(req) ?? {}
  const writable = (req) => guard(req) ?? {}

  app.get(`/${route}`, auth(read), async (req, res) => {
    const filter = { ...visible(req) }
    for (const field of fields) {
      const value = req.query[field]
      if (value !== undefined && value !== "") filter[field] = value
    }
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500)
    const skip = Math.max(Number(req.query.skip) || 0, 0)
    const rows = await collection
      .find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit)
      .toArray()
    res.json(rows.map(withId))
  })

  app.get(`/${route}/:id`, auth(read), async (req, res) => {
    const doc = await mustFind(collection, req.params.id, route, visible(req))
    res.json(withId(doc))
  })

  if (create.length) {
    app.post(`/${route}`, auth(create), async (req, res) => {
      const body = req.body ?? {}
      const now = new Date()
      const doc = {
        ...pick(body, fields),
        ...(beforeCreate ? await beforeCreate(req, body) : {}),
        ...(owner ? { [owner]: req.identity.id } : {}),
        createdAt: now,
        updatedAt: now,
      }
      const { insertedId } = await collection.insertOne(doc)
      doc._id = insertedId
      if (afterCreate) await afterCreate(req, doc)
      res.status(201).json(withId(doc))
    })
  }

  const save = async (req, res) => {
    const doc = await mustFind(collection, req.params.id, route, writable(req))
    const updates = pick(req.body ?? {}, fields)
    if (beforeUpdate) Object.assign(updates, await beforeUpdate(req, doc, updates))
    if (!Object.keys(updates).length) bad("No supported fields were provided.", "NO_CHANGES")
    updates.updatedAt = new Date()
    const updated = await collection.findOneAndUpdate(
      { _id: doc._id },
      { $set: updates },
      { returnDocument: "after" }
    )
    res.json(withId(updated ?? doc))
  }

  if (update.length) {
    app.patch(`/${route}/:id`, auth(update), save)
    app.put(`/${route}/:id`, auth(update), save)
  }

  if (remove.length) {
    app.delete(`/${route}/:id`, auth(remove), async (req, res) => {
      const doc = await mustFind(collection, req.params.id, route, writable(req))
      await collection.deleteOne({ _id: doc._id })
      res.status(204).end()
    })
  }
}

const app = express()
const origins = (process.env.CORS_ORIGINS ?? "").split(",").filter(Boolean)

app.use(cors({ origin: origins.length ? origins : true, credentials: true }))
app.use(express.json({ limit: "2mb" }))
app.use("/uploads", express.static("uploads"))

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

crud({
  path: "users",
  collection: collections.users,
  read: ["admin"],
  fields: ["role", "status", "email", "name"],
})

crud({
  path: "jobs",
  collection: collections.jobs,
  create: ["recruiter", "admin"],
  update: ["recruiter", "admin"],
  remove: ["recruiter", "admin"],
  owner: "recruiterId",
  fields: [
    "title", "location", "description", "type", "category", "salaryMin",
    "salaryMax", "salaryCurrency", "requirements", "deadline", "status",
    "companyId", "companyName", "companyLogo",
  ],
  scope: (req) => (req.identity.role === "seeker" ? { status: "active" } : {}),
  guard: (req) =>
    req.identity.role === "recruiter" ? { recruiterId: req.identity.id } : {},
  beforeCreate: async (req) => {
    const company = await collections.companies.findOne({
      ownerId: req.identity.id,
    })
    return {
      status: "active",
      postedAt: new Date(),
      companyId: company ? idString(company._id) : null,
      companyName: company?.name ?? req.user.name ?? "Company",
      companyLogo: company?.logo ?? null,
    }
  },
})

crud({
  path: "applications",
  collection: collections.applications,
  create: ["seeker"],
  update: ["seeker", "recruiter", "admin"],
  remove: ["admin"],
  owner: "seekerId",
  fields: [
    "jobId", "coverLetter", "resumeUrl", "seekerName", "seekerEmail",
    "seekerAvatar", "seekerHeadline", "seekerSkills",
    "seekerExperienceYears", "status",
  ],
  scope: (req) => {
    if (req.identity.role === "seeker") return { seekerId: req.identity.id }
    if (req.identity.role === "recruiter") return { recruiterId: req.identity.id }
    return {}
  },
  beforeCreate: async (_req, body) => {
    const job = await collections.jobs.findOne({ _id: toObjectId(body.jobId) })
    if (!job) throw new HttpError(404, "Job not found.", "NOT_FOUND")
    return {
      jobTitle: job?.title ?? null,
      companyName: job?.companyName ?? null,
      recruiterId: job?.recruiterId ?? null,
      status: "pending",
    }
  },
})

crud({
  path: "interviews",
  collection: collections.interviews,
  create: ["recruiter", "admin"],
  update: ["recruiter", "admin"],
  remove: ["recruiter", "admin"],
  owner: "recruiterId",
  fields: [
    "applicationId", "jobId", "jobTitle", "companyName", "candidateId",
    "candidateName", "scheduledAt", "durationMinutes", "type", "status",
    "meetingLink", "location", "notes",
  ],
  scope: (req) => {
    if (req.identity.role === "seeker") return { candidateId: req.identity.id }
    if (req.identity.role === "recruiter") return { recruiterId: req.identity.id }
    return {}
  },
  guard: (req) =>
    req.identity.role === "recruiter" ? { recruiterId: req.identity.id } : {},
})

app.patch("/notifications/read-all", any, async (req, res) => {
  await collections.notifications.updateMany(
    { userId: req.identity.id, read: false },
    { $set: { read: true, updatedAt: new Date() } }
  )
  res.status(204).end()
})

crud({
  path: "notifications",
  collection: collections.notifications,
  create: ROLES,
  update: ROLES,
  remove: ROLES,
  owner: "userId",
  fields: ["title", "message", "type", "read", "href"],
  scope: (req) => ({ userId: req.identity.id }),
})

crud({
  path: "reports",
  collection: collections.reports,
  create: ROLES,
  update: ["admin"],
  remove: ["admin"],
  owner: "reporterId",
  fields: ["targetType", "targetId", "targetName", "reason", "details", "status"],
  scope: (req) =>
    req.identity.role === "admin" ? {} : { reporterId: req.identity.id },
  beforeCreate: () => ({ status: "open", resolvedAt: null }),
})

app.get("/companies", auth(["admin"]), async (_req, res) => {
  const rows = await collections.companies.find({}).sort({ name: 1 }).toArray()
  res.json(rows.map(withId))
})

// ---------------------------------------------------------------------------
// Special routes (single document per user / composite keys)
// ---------------------------------------------------------------------------

const profileFields = [
  "headline", "bio", "location", "phone", "website", "skills", "education",
  "experience", "resumeUrl", "resumeName", "avatarUrl",
]
const companyFields = [
  "name", "logo", "website", "industry", "size", "location", "description",
]

async function upsertBy(collection, filter, body, fields) {
  const now = new Date()
  return collection.findOneAndUpdate(
    filter,
    {
      $set: { ...pick(body, fields), updatedAt: now },
      $setOnInsert: { ...filter, createdAt: now },
    },
    { upsert: true, returnDocument: "after" }
  )
}

app.get("/profiles/me", any, async (req, res) => {
  const profile = await collections.profiles.findOne({ userId: req.identity.id })
  res.json(withId(profile))
})

const saveProfile = async (req, res) => {
  const profile = await upsertBy(
    collections.profiles,
    { userId: req.identity.id },
    req.body ?? {},
    profileFields
  )
  res.json(withId(profile))
}
app.put("/profiles/me", any, saveProfile)
app.patch("/profiles/me", any, saveProfile)

app.get("/companies/me", any, async (req, res) => {
  const company = await collections.companies.findOne({ ownerId: req.identity.id })
  res.json(withId(company))
})

const saveCompany = async (req, res) => {
  const company = await upsertBy(
    collections.companies,
    { ownerId: req.identity.id },
    req.body ?? {},
    companyFields
  )
  res.json(withId(company))
}
app.put("/companies/me", auth(["recruiter", "admin"]), saveCompany)
app.patch("/companies/me", auth(["recruiter", "admin"]), saveCompany)

app.delete("/companies/me", auth(["recruiter", "admin"]), async (req, res) => {
  const result = await collections.companies.deleteOne({ ownerId: req.identity.id })
  if (!result.deletedCount) throw new HttpError(404, "Company not found.", "NOT_FOUND")
  res.status(204).end()
})

crud({
  path: "saved-jobs",
  collection: collections.savedJobs,
  create: ROLES,
  remove: ROLES,
  owner: "userId",
  fields: ["jobId"],
  scope: (req) => ({ userId: req.identity.id }),
})

// ---------------------------------------------------------------------------
// Health, payments, 404 and errors
// ---------------------------------------------------------------------------

app.get("/", (_req, res) => res.json({ ok: true, service: "hireloop-api" }))
app.get("/health", (_req, res) =>
  res.json({ ok: true, database: db.databaseName })
)

app.post("/payment/checkout-verify", (_req, res) =>
  res.status(501).json({
    error: "Payment verification is not implemented yet.",
    code: "NOT_IMPLEMENTED",
  })
)

app.use((_req, res) =>
  res.status(404).json({ error: "API route not found.", code: "NOT_FOUND" })
)

app.use((error, _req, res, next) => {
  if (res.headersSent) return next(error)
  let status = error instanceof HttpError ? error.status : 500
  let message =
    error instanceof HttpError
      ? error.message
      : "The server could not complete this request."
  let code = error instanceof HttpError ? error.code : "SERVER_ERROR"

  if (status >= 500) console.error(error)
  res.status(status).json({ error: message, code })
})

const server = app.listen(PORT, () =>
  console.log(`HireLoop API is running on http://localhost:${PORT}`)
)

async function shutdown(signal) {
  console.log(`${signal} received, shutting down…`)
  server.close(async () => {
    await client.close()
    process.exit(0)
  })
}
process.on("SIGINT", () => shutdown("SIGINT"))
process.on("SIGTERM", () => shutdown("SIGTERM"))

export { app, db, client }
