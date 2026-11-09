// HireLoop Express API
//
// Everything for the backend lives in this single file so it is easy to read
// top-to-bottom:
//   1. configuration + database
//   2. small helpers (validation, dates, ids)
//   3. API response "views" (what the frontend receives)
//   4. HMAC identity verification
//   5. route handlers
//   6. startup, static uploads, 404 and error handling
//
// Run with: npm run dev (nodemon) or npm start

import "dotenv/config"

import { createHmac, timingSafeEqual } from "node:crypto"
import { promises as fs } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import cors from "cors"
import express from "express"
import multer from "multer"
import { MongoClient, ObjectId } from "mongodb"

// ---------------------------------------------------------------------------
// 1. Configuration and database
// ---------------------------------------------------------------------------

const PORT = Number(process.env.PORT) || 5000
const MONGO_URI = process.env.MONGO_DB_URI

if (!MONGO_URI) {
  throw new Error("MONGO_DB_URI is missing. Add it to the server .env file.")
}

const projectRoot = path.dirname(fileURLToPath(import.meta.url))
const uploadsDirectory = path.join(projectRoot, "uploads")

await fs.mkdir(uploadsDirectory, { recursive: true })

const mongoClient = new MongoClient(MONGO_URI)
await mongoClient.connect()

const db = mongoClient.db(process.env.MONGO_DB_NAME ?? "hireloopdb")

const collections = {
  users: db.collection("user"),
  sessions: db.collection("session"),
  accounts: db.collection("account"),
  jobs: db.collection("job"),
  applications: db.collection("application"),
  profiles: db.collection("profile"),
  companies: db.collection("company"),
  savedJobs: db.collection("savedJob"),
  interviews: db.collection("interview"),
  notifications: db.collection("notification"),
  reports: db.collection("report"),
}

// Indexes keep the common dashboard queries fast. They are safe to run on
// every startup because MongoDB ignores an index that already exists.
await Promise.all([
  collections.jobs.createIndex({ recruiterId: 1, createdAt: -1 }),
  collections.jobs.createIndex({ status: 1, createdAt: -1 }),
  collections.applications.createIndex({ jobId: 1, seekerId: 1 }),
  collections.applications.createIndex({ recruiterId: 1, createdAt: -1 }),
  collections.applications.createIndex({ seekerId: 1, createdAt: -1 }),
  collections.profiles.createIndex({ userId: 1 }, { unique: true }),
  collections.companies.createIndex({ ownerId: 1 }, { unique: true }),
  collections.savedJobs.createIndex({ userId: 1, jobId: 1 }, { unique: true }),
  collections.interviews.createIndex({ candidateId: 1, scheduledAt: 1 }),
  collections.interviews.createIndex({ recruiterId: 1, scheduledAt: 1 }),
  collections.notifications.createIndex({ userId: 1, createdAt: -1 }),
  collections.reports.createIndex({ status: 1, createdAt: -1 }),
])

console.log("Connected to MongoDB")

// ---------------------------------------------------------------------------
// 2. Validation and small helpers
// ---------------------------------------------------------------------------

const USER_ROLES = ["seeker", "recruiter", "admin"]
const USER_STATUSES = ["active", "suspended"]
const JOB_STATUSES = [
  "draft",
  "pending",
  "active",
  "paused",
  "closed",
  "rejected",
  "suspended",
]
const JOB_TYPES = [
  "full-time",
  "part-time",
  "contract",
  "internship",
  "temporary",
  "remote",
]
const APPLICATION_STATUSES = [
  "pending",
  "reviewed",
  "shortlisted",
  "interview",
  "hired",
  "rejected",
  "withdrawn",
]
const INTERVIEW_STATUSES = [
  "scheduled",
  "completed",
  "cancelled",
  "rescheduled",
]
const INTERVIEW_TYPES = ["video", "phone", "onsite"]
const REPORT_STATUSES = ["open", "reviewing", "resolved", "dismissed"]
const NOTIFICATION_TYPES = ["application", "interview", "job", "system"]

class HttpError extends Error {
  constructor(status, message, code) {
    super(message)
    this.status = status
    this.code = code
  }
}

function toObjectId(value) {
  if (value instanceof ObjectId) return value
  if (typeof value === "string" && ObjectId.isValid(value)) {
    return new ObjectId(value)
  }
  return null
}

function idString(value) {
  if (!value) return null
  if (value instanceof ObjectId) return value.toString()
  return String(value)
}

function asString(value) {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed.length ? trimmed : null
}

function asNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function asBoolean(value) {
  return value === true || value === "true" || value === 1
}

function asStringArray(value) {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => asString(item))
    .filter((item) => Boolean(item))
}

function asDate(value) {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function toIso(value) {
  const date = asDate(value)
  return date ? date.toISOString() : null
}

function sanitizeText(value, max = 5000) {
  const text = asString(value)
  return text ? text.slice(0, max) : null
}

function requireEnum(value, allowed, field, fallback) {
  if (value === undefined || value === null || value === "") {
    if (fallback !== undefined) return fallback
    throw new HttpError(400, `A valid ${field} is required.`, "INVALID_FIELD")
  }
  if (!allowed.includes(value)) {
    throw new HttpError(
      400,
      `Invalid ${field}. Allowed values: ${allowed.join(", ")}.`,
      "INVALID_FIELD"
    )
  }
  return value
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function parsePagination(query) {
  const page = Math.max(1, Math.trunc(asNumber(query.page) ?? 1))
  const requestedLimit = Math.trunc(asNumber(query.limit) ?? 0)
  const limit = requestedLimit > 0 ? Math.min(requestedLimit, 100) : 0
  return { page, limit, skip: limit ? (page - 1) * limit : 0 }
}

function publicBaseUrl() {
  return (
    process.env.PUBLIC_BASE_URL?.replace(/\/+$/, "") ??
    `http://localhost:${PORT}`
  )
}

function monthKey(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`
}

function lastMonths(count = 6) {
  const months = []
  const now = new Date()
  for (let index = count - 1; index >= 0; index -= 1) {
    months.push(
      new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - index, 1))
    )
  }
  return months
}

// ---------------------------------------------------------------------------
// 3. API response views
// ---------------------------------------------------------------------------

function userView(user, extras = {}) {
  if (!user) return null
  return {
    _id: idString(user._id),
    id: idString(user._id),
    name: user.name ?? "Unnamed user",
    email: user.email ?? "",
    image: user.image ?? null,
    role: USER_ROLES.includes(user.role) ? user.role : "seeker",
    status: user.status === "suspended" ? "suspended" : "active",
    emailVerified: Boolean(user.emailVerified),
    createdAt: toIso(user.createdAt),
    updatedAt: toIso(user.updatedAt),
    headline: extras.headline ?? user.headline ?? null,
    location: extras.location ?? user.location ?? null,
    companyName: extras.companyName ?? user.companyName ?? null,
  }
}

function profileView(profile, userId) {
  return {
    _id: idString(profile?._id) ?? "me",
    id: idString(profile?._id) ?? "me",
    userId: profile?.userId ?? userId,
    headline: profile?.headline ?? null,
    bio: profile?.bio ?? null,
    location: profile?.location ?? null,
    phone: profile?.phone ?? null,
    website: profile?.website ?? null,
    skills: asStringArray(profile?.skills),
    education: Array.isArray(profile?.education) ? profile.education : [],
    experience: Array.isArray(profile?.experience) ? profile.experience : [],
    resumeUrl: profile?.resumeUrl ?? null,
    resumeName: profile?.resumeName ?? null,
    avatarUrl: profile?.avatarUrl ?? null,
    updatedAt: toIso(profile?.updatedAt),
  }
}

function companyView(company) {
  if (!company) return null
  return {
    _id: idString(company._id),
    id: idString(company._id),
    name: company.name ?? "Company",
    logo: company.logo ?? null,
    website: company.website ?? null,
    industry: company.industry ?? null,
    size: company.size ?? null,
    location: company.location ?? null,
    description: company.description ?? null,
    ownerId: company.ownerId ?? null,
  }
}

function jobView(job, extras = {}) {
  if (!job) return null
  return {
    _id: idString(job._id),
    id: idString(job._id),
    title: job.title,
    companyId: extras.companyId ?? job.companyId ?? null,
    companyName: extras.companyName ?? job.companyName ?? "Company",
    companyLogo: extras.companyLogo ?? job.companyLogo ?? null,
    recruiterId: job.recruiterId ?? null,
    location: job.location ?? "—",
    type: job.type ?? "full-time",
    category: job.category ?? null,
    salaryMin: asNumber(job.salaryMin),
    salaryMax: asNumber(job.salaryMax),
    salaryCurrency: job.salaryCurrency ?? "USD",
    description: job.description ?? "",
    requirements: asStringArray(job.requirements),
    status: job.status ?? "active",
    applicantsCount:
      extras.applicantsCount ??
      (typeof job.applicantsCount === "number" ? job.applicantsCount : 0),
    postedAt: toIso(job.postedAt ?? job.createdAt),
    deadline: toIso(job.deadline),
    createdAt: toIso(job.createdAt),
    updatedAt: toIso(job.updatedAt),
    saved: Boolean(extras.saved),
  }
}

function applicationView(application, extras = {}) {
  if (!application) return null
  const job = extras.job ?? null
  const seeker = extras.seeker ?? null
  const profile = extras.profile ?? null
  return {
    _id: idString(application._id),
    id: idString(application._id),
    jobId: application.jobId,
    jobTitle: application.jobTitle ?? job?.title ?? "Role not provided",
    companyName:
      application.companyName ?? job?.companyName ?? "Company not provided",
    companyLogo: application.companyLogo ?? job?.companyLogo ?? null,
    seekerId: application.seekerId,
    seekerName: application.seekerName ?? seeker?.name ?? "Candidate",
    seekerEmail: application.seekerEmail ?? seeker?.email ?? null,
    seekerAvatar: application.seekerAvatar ?? seeker?.image ?? null,
    seekerHeadline:
      application.seekerHeadline ?? profile?.headline ?? seeker?.headline ?? null,
    seekerSkills: asStringArray(
      application.seekerSkills ?? profile?.skills ?? []
    ),
    seekerExperienceYears:
      asNumber(application.seekerExperienceYears) ??
      asNumber(profile?.experienceYears) ??
      (Array.isArray(profile?.experience) ? profile.experience.length : null),
    status: application.status ?? "pending",
    resumeUrl: application.resumeUrl ?? profile?.resumeUrl ?? null,
    coverLetter: application.coverLetter ?? null,
    appliedAt: toIso(application.appliedAt ?? application.createdAt),
    updatedAt: toIso(application.updatedAt),
  }
}

function savedJobView(saved, job) {
  return {
    _id: idString(saved?._id),
    id: idString(saved?._id),
    job: jobView(job, { saved: true }),
    savedAt: toIso(saved?.createdAt),
  }
}

function interviewView(interview, extras = {}) {
  if (!interview) return null
  const job = extras.job ?? null
  const candidate = extras.candidate ?? null
  const recruiter = extras.recruiter ?? null
  return {
    _id: idString(interview._id),
    id: idString(interview._id),
    applicationId: interview.applicationId ?? null,
    jobId: interview.jobId ?? null,
    jobTitle: interview.jobTitle ?? job?.title ?? "Role not provided",
    companyName:
      interview.companyName ?? job?.companyName ?? "Company not provided",
    companyLogo: interview.companyLogo ?? job?.companyLogo ?? null,
    candidateId: interview.candidateId ?? null,
    candidateName:
      interview.candidateName ?? candidate?.name ?? "Candidate",
    candidateAvatar:
      interview.candidateAvatar ?? candidate?.image ?? null,
    recruiterId: interview.recruiterId ?? null,
    recruiterName: interview.recruiterName ?? recruiter?.name ?? null,
    scheduledAt: toIso(interview.scheduledAt),
    durationMinutes: asNumber(interview.durationMinutes),
    type: interview.type ?? "video",
    status: interview.status ?? "scheduled",
    meetingLink: interview.meetingLink ?? null,
    location: interview.location ?? null,
    notes: interview.notes ?? null,
    createdAt: toIso(interview.createdAt),
  }
}

function notificationView(notification) {
  return {
    _id: idString(notification._id),
    id: idString(notification._id),
    title: notification.title ?? "Notification",
    message: notification.message ?? "",
    type: notification.type ?? "system",
    read: Boolean(notification.read),
    href: notification.href ?? null,
    createdAt: toIso(notification.createdAt),
  }
}

function reportView(report, extras = {}) {
  return {
    _id: idString(report._id),
    id: idString(report._id),
    targetType: report.targetType ?? "job",
    targetId: report.targetId ?? null,
    targetName: report.targetName ?? extras.targetName ?? "Unknown target",
    reason: report.reason ?? "Reported content",
    details: report.details ?? null,
    status: report.status ?? "open",
    reporterId: report.reporterId ?? null,
    reporterName: report.reporterName ?? extras.reporterName ?? null,
    createdAt: toIso(report.createdAt),
    resolvedAt: toIso(report.resolvedAt),
  }
}

// ---------------------------------------------------------------------------
// Bulk loaders used by the serializers above
// ---------------------------------------------------------------------------

async function loadProfileMap(userIds) {
  const ids = [...new Set(userIds.filter(Boolean))]
  if (ids.length === 0) return new Map()
  const rows = await collections.profiles
    .find({ userId: { $in: ids } })
    .toArray()
  return new Map(rows.map((row) => [row.userId, row]))
}

async function loadUserMap(userIds) {
  const objectIds = [...new Set(userIds.filter(Boolean))]
    .map(toObjectId)
    .filter(Boolean)
  if (objectIds.length === 0) return new Map()
  const rows = await collections.users
    .find({ _id: { $in: objectIds } })
    .toArray()
  return new Map(rows.map((row) => [idString(row._id), row]))
}

async function loadJobMap(jobIds) {
  const objectIds = [...new Set(jobIds.filter(Boolean))]
    .map(toObjectId)
    .filter(Boolean)
  if (objectIds.length === 0) return new Map()
  const rows = await collections.jobs
    .find({ _id: { $in: objectIds } })
    .toArray()
  return new Map(rows.map((row) => [idString(row._id), row]))
}

async function loadCompanyMap(ownerIds) {
  const ids = [...new Set(ownerIds.filter(Boolean))]
  if (ids.length === 0) return new Map()
  const rows = await collections.companies
    .find({ ownerId: { $in: ids } })
    .toArray()
  return new Map(rows.map((row) => [row.ownerId, row]))
}

async function countApplicants(jobIds) {
  const ids = [...new Set(jobIds.filter(Boolean))]
  if (ids.length === 0) return new Map()
  const rows = await collections.applications
    .aggregate([
      { $match: { jobId: { $in: ids }, status: { $ne: "withdrawn" } } },
      { $group: { _id: "$jobId", count: { $sum: 1 } } },
    ])
    .toArray()
  return new Map(rows.map((row) => [row._id, row.count]))
}

async function savedJobIdSet(userId) {
  const rows = await collections.savedJobs
    .find({ userId }, { projection: { jobId: 1 } })
    .toArray()
  return new Set(rows.map((row) => row.jobId))
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

async function createNotification(
  userId,
  { title, message, type = "system", href = null }
) {
  if (!userId) return
  await collections.notifications.insertOne({
    userId,
    title,
    message,
    type: NOTIFICATION_TYPES.includes(type) ? type : "system",
    read: false,
    href,
    createdAt: new Date(),
  })
}

// ---------------------------------------------------------------------------
// View serializers that load the related documents in bulk
// ---------------------------------------------------------------------------

async function serializeUsers(rows) {
  const ids = rows.map((row) => idString(row._id))
  const [profiles, companies] = await Promise.all([
    loadProfileMap(ids),
    loadCompanyMap(ids),
  ])

  return rows.map((row) => {
    const id = idString(row._id)
    return userView(row, {
      headline: profiles.get(id)?.headline,
      location: profiles.get(id)?.location,
      companyName: companies.get(id)?.name,
    })
  })
}

async function serializeJobs(rows, viewer) {
  const jobIds = rows.map((row) => idString(row._id))
  const [applicants, savedIds, companies] = await Promise.all([
    countApplicants(jobIds),
    viewer.role === "seeker"
      ? savedJobIdSet(viewer.id)
      : Promise.resolve(new Set()),
    loadCompanyMap(rows.map((row) => row.recruiterId)),
  ])

  return rows.map((row) => {
    const id = idString(row._id)
    const company = companies.get(row.recruiterId)
    return jobView(row, {
      applicantsCount: applicants.get(id) ?? 0,
      saved: savedIds.has(id),
      companyId: company ? idString(company._id) : row.companyId,
      companyName: company?.name,
      companyLogo: company?.logo,
    })
  })
}

async function serializeApplications(rows) {
  const [jobs, users, profiles] = await Promise.all([
    loadJobMap(rows.map((row) => row.jobId)),
    loadUserMap(rows.map((row) => row.seekerId)),
    loadProfileMap(rows.map((row) => row.seekerId)),
  ])

  return rows.map((row) =>
    applicationView(row, {
      job: jobs.get(row.jobId),
      seeker: users.get(row.seekerId),
      profile: profiles.get(row.seekerId),
    })
  )
}

async function serializeInterviews(rows) {
  const [jobs, users] = await Promise.all([
    loadJobMap(rows.map((row) => row.jobId)),
    loadUserMap(
      rows.flatMap((row) => [row.candidateId, row.recruiterId].filter(Boolean))
    ),
  ])

  return rows.map((row) =>
    interviewView(row, {
      job: jobs.get(row.jobId),
      candidate: users.get(row.candidateId),
      recruiter: users.get(row.recruiterId),
    })
  )
}

// ---------------------------------------------------------------------------
// 4. HMAC identity verification
// ---------------------------------------------------------------------------

const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000

function safeEqualHex(provided, expected) {
  if (typeof provided !== "string" || !/^[a-f0-9]+$/i.test(provided)) {
    return false
  }
  const providedBuffer = Buffer.from(provided, "hex")
  const expectedBuffer = Buffer.from(expected, "hex")
  if (providedBuffer.length !== expectedBuffer.length) return false
  return timingSafeEqual(providedBuffer, expectedBuffer)
}

async function verifyIdentity(req) {
  const userId = req.get("x-hireloop-user-id")
  const role = req.get("x-hireloop-user-role")
  const timestamp = req.get("x-hireloop-timestamp")
  const signature = req.get("x-hireloop-signature")

  if (!userId || !role || !timestamp || !signature) {
    throw new HttpError(401, "Missing identity headers.", "UNAUTHORIZED")
  }

  if (!USER_ROLES.includes(role)) {
    throw new HttpError(401, "Invalid identity role.", "UNAUTHORIZED")
  }

  const issuedAt = Number(timestamp)
  if (
    !Number.isFinite(issuedAt) ||
    Math.abs(Date.now() - issuedAt) > MAX_CLOCK_SKEW_MS
  ) {
    throw new HttpError(
      401,
      "Stale or invalid identity timestamp.",
      "UNAUTHORIZED"
    )
  }

  const secret = process.env.BETTER_AUTH_SECRET
  if (!secret) {
    throw new HttpError(
      500,
      "BETTER_AUTH_SECRET is not configured on the API server.",
      "SERVER_MISCONFIGURED"
    )
  }

  const expected = createHmac("sha256", secret)
    .update(`${userId}.${role}.${timestamp}`)
    .digest("hex")

  if (!safeEqualHex(signature, expected)) {
    throw new HttpError(401, "Invalid identity signature.", "UNAUTHORIZED")
  }

  const objectId = toObjectId(userId)
  if (!objectId) {
    throw new HttpError(401, "Invalid identity user.", "UNAUTHORIZED")
  }

  const user = await collections.users.findOne({ _id: objectId })
  if (!user) {
    throw new HttpError(401, "Unknown identity user.", "UNAUTHORIZED")
  }

  const status = USER_STATUSES.includes(user.status) ? user.status : "active"
  if (status === "suspended") {
    throw new HttpError(403, "This account is suspended.", "ACCOUNT_SUSPENDED")
  }

  const databaseRole = USER_ROLES.includes(user.role) ? user.role : "seeker"
  if (databaseRole !== role) {
    throw new HttpError(403, "Identity role is out of date.", "ROLE_MISMATCH")
  }

  return {
    id: idString(user._id),
    role: databaseRole,
    status,
    user,
  }
}

function requireIdentity(allowedRoles = USER_ROLES) {
  return async (req, res, next) => {
    try {
      const identity = await verifyIdentity(req)
      if (!allowedRoles.includes(identity.role)) {
        throw new HttpError(
          403,
          "You do not have permission to perform this action.",
          "FORBIDDEN"
        )
      }
      req.identity = identity
      req.user = identity.user
      next()
    } catch (error) {
      next(error)
    }
  }
}

function requireRole(req, roles) {
  const list = Array.isArray(roles) ? roles : [roles]
  if (!list.includes(req.identity?.role)) {
    throw new HttpError(
      403,
      "You do not have permission to perform this action.",
      "FORBIDDEN"
    )
  }
}

const anyIdentity = requireIdentity()
const seekerOnly = requireIdentity(["seeker"])
const recruiterOrAdmin = requireIdentity(["recruiter", "admin"])
const adminOnly = requireIdentity(["admin"])

// ---------------------------------------------------------------------------
// File upload configuration (resume only)
// ---------------------------------------------------------------------------

const ALLOWED_RESUME_EXTENSIONS = new Set([".pdf", ".doc", ".docx"])
const MAX_RESUME_BYTES = 5 * 1024 * 1024

const resumeUpload = multer({
  storage: multer.diskStorage({
    destination(_req, _file, callback) {
      callback(null, uploadsDirectory)
    },
    filename(req, file, callback) {
      const extension = path.extname(file.originalname).toLowerCase()
      const safeExtension = ALLOWED_RESUME_EXTENSIONS.has(extension)
        ? extension
        : ""
      callback(null, `resume-${req.identity.id}-${Date.now()}${safeExtension}`)
    },
  }),
  limits: { fileSize: MAX_RESUME_BYTES, files: 1 },
  fileFilter(_req, file, callback) {
    const extension = path.extname(file.originalname).toLowerCase()
    if (!ALLOWED_RESUME_EXTENSIONS.has(extension)) {
      callback(
        new HttpError(
          400,
          "Upload a PDF, DOC, or DOCX file.",
          "INVALID_RESUME_TYPE"
        )
      )
      return
    }
    callback(null, true)
  },
}).single("resume")

// ---------------------------------------------------------------------------
// Request body parsers
// ---------------------------------------------------------------------------

function parseJobBody(body, { partial = false } = {}) {
  const updates = {}

  if (!partial || body.title !== undefined) {
    const title = asString(body.title)
    if (!title || title.length < 3) {
      throw new HttpError(
        400,
        "Job title must be at least 3 characters.",
        "INVALID_TITLE"
      )
    }
    updates.title = title.slice(0, 160)
  }

  if (!partial || body.location !== undefined) {
    const location = asString(body.location)
    if (!location) {
      throw new HttpError(400, "Job location is required.", "INVALID_LOCATION")
    }
    updates.location = location.slice(0, 160)
  }

  if (!partial || body.description !== undefined) {
    const description = asString(body.description)
    if (!description || description.length < 20) {
      throw new HttpError(
        400,
        "Job description must be at least 20 characters.",
        "INVALID_DESCRIPTION"
      )
    }
    updates.description = description
  }

  if (body.type !== undefined) {
    const type = asString(body.type)
    if (!type || !JOB_TYPES.includes(type)) {
      throw new HttpError(400, "Invalid job type.", "INVALID_TYPE")
    }
    updates.type = type
  } else if (!partial) {
    updates.type = "full-time"
  }

  if (body.category !== undefined) {
    updates.category = asString(body.category)
  }

  if (body.salaryMin !== undefined) {
    const salaryMin = body.salaryMin === null ? null : asNumber(body.salaryMin)
    if (salaryMin !== null && (salaryMin === undefined || salaryMin < 0)) {
      throw new HttpError(400, "Invalid minimum salary.", "INVALID_SALARY")
    }
    updates.salaryMin = salaryMin
  }

  if (body.salaryMax !== undefined) {
    const salaryMax = body.salaryMax === null ? null : asNumber(body.salaryMax)
    if (salaryMax !== null && (salaryMax === undefined || salaryMax < 0)) {
      throw new HttpError(400, "Invalid maximum salary.", "INVALID_SALARY")
    }
    updates.salaryMax = salaryMax
  }

  if (body.salaryCurrency !== undefined) {
    updates.salaryCurrency =
      asString(body.salaryCurrency)?.toUpperCase() ?? "USD"
  } else if (!partial) {
    updates.salaryCurrency = "USD"
  }

  if (body.requirements !== undefined) {
    updates.requirements = asStringArray(body.requirements).slice(0, 40)
  } else if (!partial) {
    updates.requirements = []
  }

  if (body.deadline !== undefined) {
    updates.deadline = body.deadline ? asDate(body.deadline) : null
    if (body.deadline && !updates.deadline) {
      throw new HttpError(400, "Invalid deadline.", "INVALID_DEADLINE")
    }
  }

  if (body.status !== undefined) {
    updates.status = requireEnum(body.status, JOB_STATUSES, "job status")
  }

  return updates
}

function parseInterviewFields(body, { partial = false } = {}) {
  const updates = {}

  if (!partial || body.scheduledAt !== undefined) {
    const scheduledAt = asDate(body.scheduledAt)
    if (!scheduledAt) {
      throw new HttpError(
        400,
        "A valid interview date and time is required.",
        "INVALID_SCHEDULE"
      )
    }
    updates.scheduledAt = scheduledAt
  }

  if (body.durationMinutes !== undefined) {
    const duration = asNumber(body.durationMinutes)
    if (duration === null || duration < 15 || duration > 480) {
      throw new HttpError(
        400,
        "Interview duration must be between 15 and 480 minutes.",
        "INVALID_DURATION"
      )
    }
    updates.durationMinutes = Math.trunc(duration)
  } else if (!partial) {
    updates.durationMinutes = 45
  }

  if (body.type !== undefined) {
    updates.type = requireEnum(body.type, INTERVIEW_TYPES, "interview type")
  } else if (!partial) {
    updates.type = "video"
  }

  if (body.meetingLink !== undefined) {
    updates.meetingLink = sanitizeText(body.meetingLink, 1000)
  }

  if (body.location !== undefined) {
    updates.location = sanitizeText(body.location, 500)
  }

  if (body.notes !== undefined) {
    updates.notes = sanitizeText(body.notes, 5000)
  }

  return updates
}

function parseEntries(value, fields) {
  if (!Array.isArray(value)) return []
  return value
    .slice(0, 25)
    .filter(
      (entry) => entry && typeof entry === "object" && !Array.isArray(entry)
    )
    .map((entry) => {
      const result = {}
      for (const [key, max] of Object.entries(fields)) {
        const raw = entry[key]
        if (key === "current") {
          result[key] = asBoolean(raw)
        } else if (key === "id") {
          result[key] = sanitizeText(raw, 100)
        } else {
          result[key] = sanitizeText(raw, max)
        }
      }
      return result
    })
    .filter((entry) =>
      Object.values(entry).some(
        (fieldValue) => typeof fieldValue === "string" && fieldValue.length
      )
    )
}

const EXPERIENCE_FIELDS = {
  id: 100,
  company: 200,
  title: 200,
  location: 200,
  startDate: 40,
  endDate: 40,
  current: 0,
  description: 4000,
}

const EDUCATION_FIELDS = {
  id: 100,
  school: 200,
  degree: 200,
  fieldOfStudy: 200,
  startDate: 40,
  endDate: 40,
}

function parseProfileBody(body) {
  const updates = {}

  const textFields = {
    headline: 200,
    bio: 5000,
    location: 200,
    phone: 60,
    website: 500,
  }

  for (const [field, max] of Object.entries(textFields)) {
    if (body[field] !== undefined) {
      updates[field] = sanitizeText(body[field], max)
    }
  }

  if (body.skills !== undefined) {
    updates.skills = asStringArray(body.skills).slice(0, 50)
  }

  if (body.experience !== undefined) {
    updates.experience = parseEntries(body.experience, EXPERIENCE_FIELDS)
  }

  if (body.education !== undefined) {
    updates.education = parseEntries(body.education, EDUCATION_FIELDS)
  }

  return updates
}

const EMPTY_PROFILE_FIELDS = {
  headline: null,
  bio: null,
  location: null,
  phone: null,
  website: null,
  skills: [],
  experience: [],
  education: [],
  resumeUrl: null,
  resumeName: null,
  avatarUrl: null,
}

function insertDefaults(updates, defaults) {
  const copy = { ...defaults }
  for (const key of Object.keys(updates)) delete copy[key]
  return copy
}

function parseCompanyBody(body) {
  const updates = {}

  if (body.name !== undefined) {
    const name = asString(body.name)
    if (!name || name.length < 2) {
      throw new HttpError(
        400,
        "Company name must be at least 2 characters.",
        "INVALID_NAME"
      )
    }
    updates.name = name.slice(0, 200)
  }

  if (body.website !== undefined) {
    const website = sanitizeText(body.website, 500)
    if (website && !/^https?:\/\//i.test(website)) {
      throw new HttpError(
        400,
        "Website must start with http:// or https://.",
        "INVALID_WEBSITE"
      )
    }
    updates.website = website
  }

  const textFields = {
    industry: 200,
    size: 100,
    location: 200,
    description: 5000,
    logo: 1000,
  }

  for (const [field, max] of Object.entries(textFields)) {
    if (body[field] !== undefined) {
      updates[field] = sanitizeText(body[field], max)
    }
  }

  return updates
}

const EMPTY_COMPANY_FIELDS = {
  logo: null,
  website: null,
  industry: null,
  size: null,
  location: null,
  description: null,
}

// ---------------------------------------------------------------------------
// 5. Express app and routes
// ---------------------------------------------------------------------------

const app = express()

const allowedOrigins = (process.env.CORS_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean)

app.disable("x-powered-by")

app.use(
  cors({
    origin(origin, callback) {
      // Requests without an Origin header are server-to-server calls.
      if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
        callback(null, true)
        return
      }
      callback(null, false)
    },
    credentials: true,
  })
)

app.use(express.json({ limit: "2mb" }))
app.use("/uploads", express.static(uploadsDirectory, { maxAge: "1h" }))

// Public health routes.
app.get("/", (_req, res) => {
  res.json({ ok: true, service: "hireloop-api" })
})

app.get("/health", (_req, res) => {
  res.json({ ok: true, database: db.databaseName })
})

// --- Users -----------------------------------------------------------------

app.get("/users", adminOnly, async (_req, res) => {
  const rows = await collections.users.find({}).toArray()
  rows.sort((a, b) => {
    const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0
    const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0
    return bTime - aTime
  })
  res.json(await serializeUsers(rows))
})

app.get("/users/:id", adminOnly, async (req, res) => {
  const objectId = toObjectId(req.params.id)
  if (!objectId) throw new HttpError(400, "Invalid user id.", "INVALID_ID")

  const user = await collections.users.findOne({ _id: objectId })
  if (!user) throw new HttpError(404, "User not found.", "NOT_FOUND")

  const [serialized] = await serializeUsers([user])
  res.json(serialized)
})

// --- Candidates ------------------------------------------------------------

app.get("/candidates", recruiterOrAdmin, async (req, res) => {
  const search = asString(req.query.search) ?? ""
  const limit = Math.min(
    Math.max(Math.trunc(asNumber(req.query.limit) ?? 24), 1),
    100
  )

  const filter = { role: "seeker" }
  if (search) {
    const pattern = new RegExp(escapeRegex(search), "i")
    filter.$or = [{ name: pattern }, { email: pattern }]
  }

  const users = await collections.users
    .find(filter)
    .sort({ createdAt: -1 })
    .limit(limit)
    .toArray()

  const rows = await serializeUsers(users)
  const trimmed = search.toLowerCase()

  res.json(
    trimmed
      ? rows.filter((row) =>
          [row.name, row.email, row.headline ?? "", row.location ?? ""]
            .join(" ")
            .toLowerCase()
            .includes(trimmed)
        )
      : rows
  )
})

// --- Jobs ------------------------------------------------------------------

app.get("/jobs", anyIdentity, async (req, res) => {
  const { role, id: userId } = req.identity
  const scope = asString(req.query.scope)
  const search = asString(req.query.search)
  const status = asString(req.query.status)
  const { limit, skip } = parsePagination(req.query)

  const filter = {}

  if (scope === "mine") {
    requireRole(req, ["recruiter", "admin"])
    filter.recruiterId = userId
    if (status) {
      filter.status = requireEnum(status, JOB_STATUSES, "job status")
    }
  } else if (role === "seeker") {
    // Seekers only ever browse open jobs.
    filter.status = "active"
  } else if (role === "recruiter") {
    filter.status = status
      ? requireEnum(status, JOB_STATUSES, "job status")
      : "active"
  } else if (status) {
    filter.status = requireEnum(status, JOB_STATUSES, "job status")
  }

  if (search) {
    const pattern = new RegExp(escapeRegex(search), "i")
    filter.$or = [
      { title: pattern },
      { companyName: pattern },
      { location: pattern },
      { category: pattern },
    ]
  }

  let cursor = collections.jobs.find(filter).sort({ createdAt: -1 })
  if (skip) cursor = cursor.skip(skip)
  if (limit) cursor = cursor.limit(limit)

  const rows = await cursor.toArray()
  res.json(await serializeJobs(rows, req.identity))
})

app.get("/jobs/recommended", seekerOnly, async (req, res) => {
  const profile = await collections.profiles.findOne({
    userId: req.identity.id,
  })
  const skills = asStringArray(profile?.skills).map((skill) =>
    skill.toLowerCase()
  )

  const applied = await collections.applications
    .find(
      { seekerId: req.identity.id, status: { $ne: "withdrawn" } },
      { projection: { jobId: 1 } }
    )
    .toArray()
  const appliedIds = new Set(applied.map((row) => row.jobId))

  const jobs = await collections.jobs
    .find({ status: "active" })
    .sort({ createdAt: -1 })
    .limit(30)
    .toArray()

  const matched = jobs
    .filter((job) => !appliedIds.has(idString(job._id)))
    .map((job) => {
      const requirements = asStringArray(job.requirements).map((item) =>
        item.toLowerCase()
      )
      const overlap = requirements.filter((item) =>
        skills.includes(item)
      ).length
      return { job, overlap }
    })
    .sort((a, b) => {
      if (b.overlap !== a.overlap) return b.overlap - a.overlap
      return new Date(b.job.createdAt ?? 0) - new Date(a.job.createdAt ?? 0)
    })
    .slice(0, 9)
    .map((entry) => entry.job)

  res.json(await serializeJobs(matched, req.identity))
})

app.get("/jobs/:id", anyIdentity, async (req, res) => {
  const objectId = toObjectId(req.params.id)
  if (!objectId) throw new HttpError(400, "Invalid job id.", "INVALID_ID")

  const job = await collections.jobs.findOne({ _id: objectId })
  if (!job) throw new HttpError(404, "Job not found.", "NOT_FOUND")

  const [serialized] = await serializeJobs([job], req.identity)
  res.json(serialized)
})

app.post("/jobs", recruiterOrAdmin, async (req, res) => {
  const updates = parseJobBody(req.body ?? {})
  const company = await collections.companies.findOne({
    ownerId: req.identity.id,
  })

  const now = new Date()
  const document = {
    ...updates,
    recruiterId: req.identity.id,
    companyId: company ? idString(company._id) : null,
    companyName: company?.name ?? req.user.name ?? "Company",
    companyLogo: company?.logo ?? null,
    status: updates.status ?? "active",
    postedAt: now,
    createdAt: now,
    updatedAt: now,
  }

  const result = await collections.jobs.insertOne(document)
  document._id = result.insertedId

  if (req.identity.role === "recruiter") {
    const admins = await collections.users
      .find({ role: "admin" }, { projection: { _id: 1 } })
      .toArray()

    await Promise.all(
      admins.map((admin) =>
        createNotification(idString(admin._id), {
          title: "New job published",
          message: `${req.user.name ?? "A recruiter"} published “${document.title}”.`,
          type: "job",
          href: "/dashboard/admin/jobs",
        })
      )
    )
  }

  const [serialized] = await serializeJobs([document], req.identity)
  res.status(201).json(serialized)
})

app.patch("/jobs/:id", recruiterOrAdmin, async (req, res) => {
  const objectId = toObjectId(req.params.id)
  if (!objectId) throw new HttpError(400, "Invalid job id.", "INVALID_ID")

  const job = await collections.jobs.findOne({ _id: objectId })
  if (!job) throw new HttpError(404, "Job not found.", "NOT_FOUND")

  if (req.identity.role !== "admin" && job.recruiterId !== req.identity.id) {
    throw new HttpError(
      403,
      "You can only update your own jobs.",
      "FORBIDDEN"
    )
  }

  const updates = parseJobBody(req.body ?? {}, { partial: true })
  if (Object.keys(updates).length === 0) {
    throw new HttpError(400, "No supported fields were provided.", "NO_CHANGES")
  }

  const nextMin =
    updates.salaryMin !== undefined ? updates.salaryMin : job.salaryMin
  const nextMax =
    updates.salaryMax !== undefined ? updates.salaryMax : job.salaryMax
  if (nextMin != null && nextMax != null && nextMin > nextMax) {
    throw new HttpError(
      400,
      "Minimum salary cannot be greater than maximum salary.",
      "INVALID_SALARY_RANGE"
    )
  }

  updates.updatedAt = new Date()
  const updated = await collections.jobs.findOneAndUpdate(
    { _id: objectId },
    { $set: updates },
    { returnDocument: "after" }
  )

  const [serialized] = await serializeJobs([updated ?? job], req.identity)
  res.json(serialized)
})

app.delete("/jobs/:id", recruiterOrAdmin, async (req, res) => {
  const objectId = toObjectId(req.params.id)
  if (!objectId) throw new HttpError(400, "Invalid job id.", "INVALID_ID")

  const job = await collections.jobs.findOne({ _id: objectId })
  if (!job) throw new HttpError(404, "Job not found.", "NOT_FOUND")

  if (req.identity.role !== "admin" && job.recruiterId !== req.identity.id) {
    throw new HttpError(
      403,
      "You can only delete your own jobs.",
      "FORBIDDEN"
    )
  }

  const jobId = idString(job._id)

  await Promise.all([
    collections.jobs.deleteOne({ _id: objectId }),
    collections.applications.deleteMany({ jobId }),
    collections.interviews.deleteMany({ jobId }),
    collections.savedJobs.deleteMany({ jobId }),
  ])

  res.status(204).end()
})

// --- Applications ----------------------------------------------------------

const APPLICATION_STATUS_LABELS = {
  pending: "Pending",
  reviewed: "Reviewed",
  shortlisted: "Shortlisted",
  interview: "Interview",
  hired: "Hired",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
}

async function findRecruiterJobIds(recruiterId) {
  const jobs = await collections.jobs
    .find({ recruiterId }, { projection: { _id: 1 } })
    .toArray()
  return jobs.map((job) => idString(job._id))
}

app.get("/applications", anyIdentity, async (req, res) => {
  const scope = asString(req.query.scope)
  const status = asString(req.query.status)
  const search = asString(req.query.search)
  const { limit, skip } = parsePagination(req.query)

  const filter = {}

  if (status) {
    filter.status = requireEnum(
      status,
      APPLICATION_STATUSES,
      "application status"
    )
  }

  if (req.identity.role === "seeker") {
    filter.seekerId = req.identity.id
  } else if (req.identity.role === "recruiter") {
    const jobIds = await findRecruiterJobIds(req.identity.id)
    if (jobIds.length === 0) return res.json([])
    filter.jobId = { $in: jobIds }
  } else if (scope !== "all" && scope !== "mine") {
    // Administrators default to every application.
  }

  if (search) {
    const pattern = new RegExp(escapeRegex(search), "i")
    filter.$or = [
      { jobTitle: pattern },
      { companyName: pattern },
      { seekerName: pattern },
      { seekerEmail: pattern },
    ]
  }

  let cursor = collections.applications.find(filter).sort({ createdAt: -1 })
  if (skip) cursor = cursor.skip(skip)
  if (limit) cursor = cursor.limit(limit)

  const rows = await cursor.toArray()
  res.json(await serializeApplications(rows))
})

app.get("/applications/:id", anyIdentity, async (req, res) => {
  const objectId = toObjectId(req.params.id)
  if (!objectId) {
    throw new HttpError(400, "Invalid application id.", "INVALID_ID")
  }

  const application = await collections.applications.findOne({
    _id: objectId,
  })
  if (!application) {
    throw new HttpError(404, "Application not found.", "NOT_FOUND")
  }

  if (
    req.identity.role === "seeker" &&
    application.seekerId !== req.identity.id
  ) {
    throw new HttpError(
      403,
      "You can only view your own applications.",
      "FORBIDDEN"
    )
  }

  if (
    req.identity.role === "recruiter" &&
    application.recruiterId !== req.identity.id
  ) {
    throw new HttpError(
      403,
      "You can only view applications to your jobs.",
      "FORBIDDEN"
    )
  }

  const [serialized] = await serializeApplications([application])
  res.json(serialized)
})

app.post("/applications", seekerOnly, async (req, res) => {
  const body = req.body ?? {}
  const jobId = asString(body.jobId)
  const jobObjectId = toObjectId(jobId)
  if (!jobObjectId) {
    throw new HttpError(400, "Invalid job id.", "INVALID_JOB")
  }

  const job = await collections.jobs.findOne({ _id: jobObjectId })
  if (!job) throw new HttpError(404, "Job not found.", "NOT_FOUND")
  if (job.status !== "active") {
    throw new HttpError(
      400,
      "This job is no longer accepting applications.",
      "JOB_CLOSED"
    )
  }
  if (job.deadline && new Date(job.deadline).getTime() < Date.now()) {
    throw new HttpError(
      400,
      "The application deadline has passed.",
      "JOB_EXPIRED"
    )
  }

  const existing = await collections.applications.findOne({
    jobId,
    seekerId: req.identity.id,
    status: { $ne: "withdrawn" },
  })
  if (existing) {
    throw new HttpError(
      409,
      "You have already applied to this job.",
      "ALREADY_APPLIED"
    )
  }

  const profile = await collections.profiles.findOne({
    userId: req.identity.id,
  })
  const company = job.companyId
    ? await collections.companies.findOne({ _id: toObjectId(job.companyId) })
    : null

  const now = new Date()
  const document = {
    jobId,
    recruiterId: job.recruiterId ?? null,
    jobTitle: job.title,
    companyName: company?.name ?? job.companyName ?? "Company",
    companyLogo: company?.logo ?? job.companyLogo ?? null,
    seekerId: req.identity.id,
    seekerName: req.user.name ?? "Candidate",
    seekerEmail: req.user.email ?? null,
    seekerAvatar: req.user.image ?? null,
    seekerHeadline: profile?.headline ?? null,
    seekerSkills: profile?.skills ?? [],
    seekerExperienceYears: Array.isArray(profile?.experience)
      ? profile.experience.length
      : null,
    status: "pending",
    resumeUrl: profile?.resumeUrl ?? null,
    coverLetter: asString(body.coverLetter)?.slice(0, 8000) ?? null,
    appliedAt: now,
    createdAt: now,
    updatedAt: now,
  }

  const result = await collections.applications.insertOne(document)
  document._id = result.insertedId

  await Promise.all([
    createNotification(req.identity.id, {
      title: "Application submitted",
      message: `Your application for “${job.title}” is pending review.`,
      type: "application",
      href: "/dashboard/seeker/applications",
    }),
    job.recruiterId
      ? createNotification(job.recruiterId, {
          title: "New application",
          message: `${req.user.name ?? "A candidate"} applied for “${job.title}”.`,
          type: "application",
          href: `/dashboard/recruiter/applicants?jobId=${jobId}`,
        })
      : Promise.resolve(),
  ])

  const [serialized] = await serializeApplications([document])
  res.status(201).json(serialized)
})

app.patch("/applications/:id", recruiterOrAdmin, async (req, res) => {
  const objectId = toObjectId(req.params.id)
  if (!objectId) {
    throw new HttpError(400, "Invalid application id.", "INVALID_ID")
  }

  const application = await collections.applications.findOne({
    _id: objectId,
  })
  if (!application) {
    throw new HttpError(404, "Application not found.", "NOT_FOUND")
  }

  if (
    req.identity.role === "recruiter" &&
    application.recruiterId !== req.identity.id
  ) {
    throw new HttpError(
      403,
      "You can only update applications to your jobs.",
      "FORBIDDEN"
    )
  }

  if (application.status === "withdrawn") {
    throw new HttpError(
      400,
      "A withdrawn application cannot be moved.",
      "INVALID_TRANSITION"
    )
  }

  const status = requireEnum(
    req.body?.status,
    APPLICATION_STATUSES,
    "application status"
  )

  if (status === "withdrawn") {
    throw new HttpError(
      400,
      "Use the withdraw action to move an application to withdrawn.",
      "INVALID_TRANSITION"
    )
  }

  if (application.status === status) {
    const [serialized] = await serializeApplications([application])
    return res.json(serialized)
  }

  const updated = await collections.applications.findOneAndUpdate(
    { _id: objectId },
    { $set: { status, updatedAt: new Date() } },
    { returnDocument: "after" }
  )

  await createNotification(application.seekerId, {
    title: `Application ${APPLICATION_STATUS_LABELS[status] ?? status}`,
    message: `Your application for “${application.jobTitle}” moved to ${APPLICATION_STATUS_LABELS[status] ?? status}.`,
    type: "application",
    href: "/dashboard/seeker/applications",
  })

  const [serialized] = await serializeApplications([updated ?? application])
  res.json(serialized)
})

app.delete("/applications/:id", anyIdentity, async (req, res) => {
  const objectId = toObjectId(req.params.id)
  if (!objectId) {
    throw new HttpError(400, "Invalid application id.", "INVALID_ID")
  }

  const application = await collections.applications.findOne({
    _id: objectId,
  })
  if (!application) {
    throw new HttpError(404, "Application not found.", "NOT_FOUND")
  }

  if (req.identity.role === "seeker") {
    if (application.seekerId !== req.identity.id) {
      throw new HttpError(
        403,
        "You can only withdraw your own applications.",
        "FORBIDDEN"
      )
    }

    await collections.applications.updateOne(
      { _id: objectId },
      { $set: { status: "withdrawn", updatedAt: new Date() } }
    )

    if (application.recruiterId) {
      await createNotification(application.recruiterId, {
        title: "Application withdrawn",
        message: `${application.seekerName} withdrew their application for “${application.jobTitle}”.`,
        type: "application",
        href: "/dashboard/recruiter/applicants",
      })
    }

    return res.json({ ...applicationView(application), status: "withdrawn" })
  }

  requireRole(req, ["admin"])
  await collections.applications.deleteOne({ _id: objectId })
  await collections.interviews.deleteMany({
    applicationId: idString(application._id),
  })
  res.status(204).end()
})

// --- Saved jobs ------------------------------------------------------------

app.get("/saved-jobs", seekerOnly, async (req, res) => {
  const rows = await collections.savedJobs
    .find({ userId: req.identity.id })
    .sort({ createdAt: -1 })
    .toArray()

  const objectIds = rows.map((row) => toObjectId(row.jobId)).filter(Boolean)
  const jobs = objectIds.length
    ? await collections.jobs.find({ _id: { $in: objectIds } }).toArray()
    : []
  const jobMap = new Map(jobs.map((job) => [idString(job._id), job]))

  res.json(
    rows
      .map((row) => {
        const job = jobMap.get(row.jobId)
        return job ? savedJobView(row, job) : null
      })
      .filter(Boolean)
  )
})

app.post("/saved-jobs", seekerOnly, async (req, res) => {
  const jobId = asString(req.body?.jobId)
  const objectId = toObjectId(jobId)
  if (!objectId) throw new HttpError(400, "Invalid job id.", "INVALID_JOB")

  const job = await collections.jobs.findOne({ _id: objectId })
  if (!job) throw new HttpError(404, "Job not found.", "NOT_FOUND")

  const saved = await collections.savedJobs.findOneAndUpdate(
    { userId: req.identity.id, jobId },
    {
      $setOnInsert: {
        userId: req.identity.id,
        jobId,
        createdAt: new Date(),
      },
    },
    { upsert: true, returnDocument: "after" }
  )

  res.status(201).json(savedJobView(saved, job))
})

app.delete("/saved-jobs/:jobId", seekerOnly, async (req, res) => {
  const jobId = asString(req.params.jobId)
  if (!jobId) throw new HttpError(400, "Invalid job id.", "INVALID_JOB")

  const result = await collections.savedJobs.deleteOne({
    userId: req.identity.id,
    jobId,
  })
  if (result.deletedCount === 0) {
    throw new HttpError(404, "Saved job not found.", "NOT_FOUND")
  }

  res.status(204).end()
})

// --- Interviews ------------------------------------------------------------

async function assertInterviewAccess(req, interview) {
  if (req.identity.role === "admin") return

  if (req.identity.role === "recruiter") {
    if (interview.recruiterId !== req.identity.id) {
      throw new HttpError(
        403,
        "You can only manage interviews for your own jobs.",
        "FORBIDDEN"
      )
    }
    return
  }

  if (interview.candidateId !== req.identity.id) {
    throw new HttpError(
      403,
      "You can only view your own interviews.",
      "FORBIDDEN"
    )
  }
}

app.get("/interviews", anyIdentity, async (req, res) => {
  const scope = asString(req.query.scope)
  const upcoming = req.query.upcoming === "true"
  const status = asString(req.query.status)

  const filter = {}

  if (req.identity.role === "seeker") {
    filter.candidateId = req.identity.id
  } else if (req.identity.role === "recruiter") {
    filter.recruiterId = req.identity.id
  } else if (scope !== "all" && scope !== "mine") {
    // Administrators default to every interview.
  }

  if (status) {
    filter.status = requireEnum(status, INTERVIEW_STATUSES, "interview status")
  }

  if (upcoming) {
    filter.scheduledAt = { $gte: new Date() }
    filter.status = filter.status ?? { $in: ["scheduled", "rescheduled"] }
  }

  const rows = await collections.interviews
    .find(filter)
    .sort(upcoming ? { scheduledAt: 1 } : { createdAt: -1 })
    .limit(200)
    .toArray()

  res.json(await serializeInterviews(rows))
})

app.get("/interviews/:id", anyIdentity, async (req, res) => {
  const objectId = toObjectId(req.params.id)
  if (!objectId) throw new HttpError(400, "Invalid interview id.", "INVALID_ID")

  const interview = await collections.interviews.findOne({ _id: objectId })
  if (!interview) {
    throw new HttpError(404, "Interview not found.", "NOT_FOUND")
  }

  await assertInterviewAccess(req, interview)
  const [serialized] = await serializeInterviews([interview])
  res.json(serialized)
})

app.post("/interviews", recruiterOrAdmin, async (req, res) => {
  const body = req.body ?? {}
  const schedule = parseInterviewFields(body)

  const applicationId = asString(body.applicationId)
  let application = null

  if (applicationId) {
    const applicationObjectId = toObjectId(applicationId)
    if (!applicationObjectId) {
      throw new HttpError(
        400,
        "Invalid application id.",
        "INVALID_APPLICATION"
      )
    }
    application = await collections.applications.findOne({
      _id: applicationObjectId,
    })
    if (!application) {
      throw new HttpError(404, "Application not found.", "NOT_FOUND")
    }
    if (
      req.identity.role === "recruiter" &&
      application.recruiterId !== req.identity.id
    ) {
      throw new HttpError(
        403,
        "You can only schedule interviews for your own applicants.",
        "FORBIDDEN"
      )
    }
    if (["withdrawn", "rejected", "hired"].includes(application.status ?? "")) {
      throw new HttpError(
        400,
        "This application is no longer active in the hiring pipeline.",
        "INVALID_APPLICATION_STATE"
      )
    }
  }

  const jobId = asString(body.jobId) ?? application?.jobId ?? null
  const candidateId = asString(body.candidateId) ?? application?.seekerId ?? null

  if (!jobId || !candidateId) {
    throw new HttpError(
      400,
      "An application or both jobId and candidateId are required.",
      "INVALID_INTERVIEW"
    )
  }

  const jobObjectId = toObjectId(jobId)
  if (!jobObjectId) throw new HttpError(400, "Invalid job id.", "INVALID_JOB")
  const job = await collections.jobs.findOne({ _id: jobObjectId })
  if (!job) throw new HttpError(404, "Job not found.", "NOT_FOUND")

  if (
    req.identity.role === "recruiter" &&
    job.recruiterId !== req.identity.id
  ) {
    throw new HttpError(
      403,
      "You can only schedule interviews for your own jobs.",
      "FORBIDDEN"
    )
  }

  const candidateObjectId = toObjectId(candidateId)
  if (!candidateObjectId) {
    throw new HttpError(400, "Invalid candidate id.", "INVALID_CANDIDATE")
  }
  const candidate = await collections.users.findOne({
    _id: candidateObjectId,
  })
  if (!candidate) {
    throw new HttpError(404, "Candidate not found.", "NOT_FOUND")
  }

  const company = job.companyId
    ? await collections.companies.findOne({ _id: toObjectId(job.companyId) })
    : null

  const now = new Date()
  const document = {
    applicationId: application ? idString(application._id) : null,
    jobId,
    jobTitle: job.title,
    companyName:
      company?.name ?? application?.companyName ?? job.companyName ?? "Company",
    companyLogo:
      company?.logo ?? application?.companyLogo ?? job.companyLogo ?? null,
    candidateId,
    candidateName: candidate.name ?? application?.seekerName ?? "Candidate",
    candidateAvatar: candidate.image ?? application?.seekerAvatar ?? null,
    recruiterId: req.identity.id,
    recruiterName: req.user.name ?? "Recruiter",
    ...schedule,
    status: "scheduled",
    createdAt: now,
    updatedAt: now,
  }

  const result = await collections.interviews.insertOne(document)
  document._id = result.insertedId

  await Promise.all([
    application
      ? collections.applications.updateOne(
          { _id: toObjectId(application._id) },
          { $set: { status: "interview", updatedAt: now } }
        )
      : Promise.resolve(),
    createNotification(candidateId, {
      title: "Interview scheduled",
      message: `${document.recruiterName} scheduled an interview for “${document.jobTitle}”.`,
      type: "interview",
      href: "/dashboard/seeker/interviews",
    }),
  ])

  const [serialized] = await serializeInterviews([document])
  res.status(201).json(serialized)
})

app.patch("/interviews/:id", recruiterOrAdmin, async (req, res) => {
  const objectId = toObjectId(req.params.id)
  if (!objectId) throw new HttpError(400, "Invalid interview id.", "INVALID_ID")

  const interview = await collections.interviews.findOne({ _id: objectId })
  if (!interview) {
    throw new HttpError(404, "Interview not found.", "NOT_FOUND")
  }

  await assertInterviewAccess(req, interview)

  const body = req.body ?? {}
  const updates = {}

  if (body.status !== undefined) {
    updates.status = requireEnum(
      body.status,
      INTERVIEW_STATUSES,
      "interview status"
    )
  }

  if (
    body.scheduledAt !== undefined ||
    body.durationMinutes !== undefined ||
    body.type !== undefined ||
    body.meetingLink !== undefined ||
    body.location !== undefined ||
    body.notes !== undefined
  ) {
    Object.assign(updates, parseInterviewFields(body, { partial: true }))
  }

  if (Object.keys(updates).length === 0) {
    throw new HttpError(400, "No supported fields were provided.", "NO_CHANGES")
  }

  if (
    updates.scheduledAt &&
    !updates.status &&
    ["scheduled", "rescheduled"].includes(interview.status ?? "")
  ) {
    updates.status = "rescheduled"
  }

  updates.updatedAt = new Date()

  const updated = await collections.interviews.findOneAndUpdate(
    { _id: objectId },
    { $set: updates },
    { returnDocument: "after" }
  )

  const finalInterview = updated ?? interview

  if (updates.status && updates.status !== interview.status) {
    await createNotification(finalInterview.candidateId, {
      title: "Interview updated",
      message: `Your interview for “${finalInterview.jobTitle}” is now ${finalInterview.status}.`,
      type: "interview",
      href: "/dashboard/seeker/interviews",
    })
  }

  const [serialized] = await serializeInterviews([finalInterview])
  res.json(serialized)
})

app.delete("/interviews/:id", recruiterOrAdmin, async (req, res) => {
  const objectId = toObjectId(req.params.id)
  if (!objectId) throw new HttpError(400, "Invalid interview id.", "INVALID_ID")

  const interview = await collections.interviews.findOne({ _id: objectId })
  if (!interview) {
    throw new HttpError(404, "Interview not found.", "NOT_FOUND")
  }

  await assertInterviewAccess(req, interview)
  await collections.interviews.deleteOne({ _id: objectId })

  await createNotification(interview.candidateId, {
    title: "Interview cancelled",
    message: `The interview for “${interview.jobTitle}” was removed.`,
    type: "interview",
    href: "/dashboard/seeker/interviews",
  })

  res.status(204).end()
})

// --- Notifications ---------------------------------------------------------

app.get("/notifications", anyIdentity, async (req, res) => {
  const limit = Math.min(
    Math.max(Math.trunc(asNumber(req.query.limit) ?? 50), 1),
    200
  )
  const filter = { userId: req.identity.id }
  if (req.query.unread === "true") filter.read = false

  const rows = await collections.notifications
    .find(filter)
    .sort({ createdAt: -1 })
    .limit(limit)
    .toArray()

  res.json(rows.map(notificationView))
})

app.patch("/notifications/read-all", anyIdentity, async (req, res) => {
  await collections.notifications.updateMany(
    { userId: req.identity.id, read: false },
    { $set: { read: true, updatedAt: new Date() } }
  )
  res.status(204).end()
})

app.patch("/notifications/:id/read", anyIdentity, async (req, res) => {
  const objectId = toObjectId(req.params.id)
  if (!objectId) {
    throw new HttpError(400, "Invalid notification id.", "INVALID_ID")
  }

  const notification = await collections.notifications.findOneAndUpdate(
    { _id: objectId, userId: req.identity.id },
    { $set: { read: true, updatedAt: new Date() } },
    { returnDocument: "after" }
  )

  if (!notification) {
    throw new HttpError(404, "Notification not found.", "NOT_FOUND")
  }

  res.json(notificationView(notification))
})

app.delete("/notifications/:id", anyIdentity, async (req, res) => {
  const objectId = toObjectId(req.params.id)
  if (!objectId) {
    throw new HttpError(400, "Invalid notification id.", "INVALID_ID")
  }

  const result = await collections.notifications.deleteOne({
    _id: objectId,
    userId: req.identity.id,
  })
  if (result.deletedCount === 0) {
    throw new HttpError(404, "Notification not found.", "NOT_FOUND")
  }

  res.status(204).end()
})

// --- Profiles --------------------------------------------------------------

app.get("/profiles/me", anyIdentity, async (req, res) => {
  const profile = await collections.profiles.findOne({
    userId: req.identity.id,
  })
  res.json(profileView(profile, req.identity.id))
})

app.put("/profiles/me", anyIdentity, async (req, res) => {
  const updates = parseProfileBody(req.body ?? {})
  if (Object.keys(updates).length === 0) {
    throw new HttpError(400, "No supported fields were provided.", "NO_CHANGES")
  }

  const now = new Date()
  const profile = await collections.profiles.findOneAndUpdate(
    { userId: req.identity.id },
    {
      $set: { ...updates, updatedAt: now },
      $setOnInsert: {
        userId: req.identity.id,
        ...insertDefaults(updates, EMPTY_PROFILE_FIELDS),
        createdAt: now,
      },
    },
    { upsert: true, returnDocument: "after" }
  )

  res.json(profileView(profile, req.identity.id))
})

app.post(
  "/profiles/me/resume",
  anyIdentity,
  resumeUpload,
  async (req, res) => {
    if (!req.file) {
      throw new HttpError(400, "Choose a resume file to upload.", "NO_FILE")
    }

    const existing = await collections.profiles.findOne({
      userId: req.identity.id,
    })
    const previousUrl = existing?.resumeUrl ?? null
    const resumeUrl = `${publicBaseUrl()}/uploads/${req.file.filename}`
    const resumeFields = {
      resumeUrl,
      resumeName: req.file.originalname,
      resumeMimeType: req.file.mimetype ?? null,
      resumeSize: req.file.size ?? null,
    }

    const updated = await collections.profiles.findOneAndUpdate(
      { userId: req.identity.id },
      {
        $set: { ...resumeFields, updatedAt: new Date() },
        $setOnInsert: {
          userId: req.identity.id,
          ...insertDefaults(resumeFields, EMPTY_PROFILE_FIELDS),
          createdAt: new Date(),
        },
      },
      { upsert: true, returnDocument: "after" }
    )

    if (previousUrl && previousUrl !== resumeUrl) {
      const previousName = previousUrl.split("/uploads/")[1]
      if (previousName && !previousName.includes("..")) {
        await fs
          .unlink(path.join(uploadsDirectory, previousName))
          .catch(() => undefined)
      }
    }

    res.status(201).json(profileView(updated, req.identity.id))
  }
)

app.delete("/profiles/me/resume", anyIdentity, async (req, res) => {
  const profile = await collections.profiles.findOne({
    userId: req.identity.id,
  })
  if (!profile?.resumeUrl) {
    throw new HttpError(
      404,
      "No resume is attached to this profile.",
      "NOT_FOUND"
    )
  }

  const fileName = profile.resumeUrl.split("/uploads/")[1]
  if (fileName && !fileName.includes("..")) {
    await fs
      .unlink(path.join(uploadsDirectory, fileName))
      .catch(() => undefined)
  }

  const updated = await collections.profiles.findOneAndUpdate(
    { userId: req.identity.id },
    {
      $set: { updatedAt: new Date() },
      $unset: {
        resumeUrl: "",
        resumeName: "",
        resumeMimeType: "",
        resumeSize: "",
      },
    },
    { returnDocument: "after" }
  )

  res.json(profileView(updated, req.identity.id))
})

app.get("/profiles/:id", adminOnly, async (req, res) => {
  const userId = req.params.id
  if (!toObjectId(userId)) {
    throw new HttpError(400, "Invalid user id.", "INVALID_ID")
  }

  const profile = await collections.profiles.findOne({ userId })
  if (!profile) {
    throw new HttpError(404, "Profile not found.", "NOT_FOUND")
  }

  res.json(profileView(profile, userId))
})

// --- Companies -------------------------------------------------------------

app.get("/companies", adminOnly, async (_req, res) => {
  const rows = await collections.companies.find({}).sort({ name: 1 }).toArray()
  res.json(rows.map(companyView))
})

app.get("/companies/me", anyIdentity, async (req, res) => {
  const company = await collections.companies.findOne({
    ownerId: req.identity.id,
  })
  // `null` means "not created yet", which the form understands.
  res.json(company ? companyView(company) : null)
})

app.put("/companies/me", recruiterOrAdmin, async (req, res) => {
  const updates = parseCompanyBody(req.body ?? {})
  if (Object.keys(updates).length === 0) {
    throw new HttpError(400, "No supported fields were provided.", "NO_CHANGES")
  }

  const now = new Date()
  const company = await collections.companies.findOneAndUpdate(
    { ownerId: req.identity.id },
    {
      $set: { ...updates, updatedAt: now },
      $setOnInsert: {
        ownerId: req.identity.id,
        ...insertDefaults(updates, EMPTY_COMPANY_FIELDS),
        createdAt: now,
      },
    },
    { upsert: true, returnDocument: "after" }
  )

  if (updates.name) {
    await collections.jobs.updateMany(
      { recruiterId: req.identity.id },
      {
        $set: {
          companyId: idString(company._id),
          companyName: company.name,
          companyLogo: company.logo ?? null,
          updatedAt: now,
        },
      }
    )
  }

  res.json(companyView(company))
})

app.delete("/companies/me", recruiterOrAdmin, async (req, res) => {
  const company = await collections.companies.findOne({
    ownerId: req.identity.id,
  })
  if (!company) {
    throw new HttpError(404, "Company profile not found.", "NOT_FOUND")
  }

  await Promise.all([
    collections.companies.deleteOne({ _id: company._id }),
    collections.jobs.updateMany(
      { recruiterId: req.identity.id },
      { $set: { companyId: null, updatedAt: new Date() } }
    ),
  ])

  res.status(204).end()
})

// --- Admin -----------------------------------------------------------------

async function monthlyTrend(collection, dateField, filter = {}) {
  const months = lastMonths(6)
  const start = months[0]

  const rows = await collection
    .aggregate([
      { $match: { ...filter, [dateField]: { $gte: start } } },
      {
        $group: {
          _id: {
            $dateToString: { format: "%Y-%m", date: `$${dateField}` },
          },
          value: { $sum: 1 },
        },
      },
    ])
    .toArray()

  const values = new Map(rows.map((row) => [row._id, row.value]))
  return months.map((month) => ({
    month: monthKey(month),
    value: values.get(monthKey(month)) ?? 0,
  }))
}

async function distribution(collection, field, filter = {}) {
  const rows = await collection
    .aggregate([
      { $match: filter },
      { $group: { _id: `$${field}`, value: { $sum: 1 } } },
      { $sort: { value: -1, _id: 1 } },
    ])
    .toArray()

  return rows.map((row) => ({
    name: row._id ?? "unknown",
    value: row.value,
  }))
}

app.get("/admin/stats", adminOnly, async (_req, res) => {
  const [
    users,
    seekers,
    recruiters,
    admins,
    jobs,
    applications,
    openReports,
  ] = await Promise.all([
    collections.users.countDocuments({}),
    collections.users.countDocuments({ role: "seeker" }),
    collections.users.countDocuments({ role: "recruiter" }),
    collections.users.countDocuments({ role: "admin" }),
    collections.jobs.countDocuments({}),
    collections.applications.countDocuments({}),
    collections.reports.countDocuments({ status: "open" }),
  ])

  res.json({
    users,
    seekers,
    recruiters,
    admins,
    jobs,
    applications,
    openReports,
  })
})

app.get("/admin/analytics", adminOnly, async (_req, res) => {
  const [
    userRegistrationTrend,
    jobPostingTrend,
    applicationActivity,
    roleDistribution,
    jobStatusDistribution,
  ] = await Promise.all([
    monthlyTrend(collections.users, "createdAt"),
    monthlyTrend(collections.jobs, "createdAt"),
    monthlyTrend(collections.applications, "appliedAt"),
    distribution(collections.users, "role"),
    distribution(collections.jobs, "status"),
  ])

  res.json({
    userRegistrationTrend,
    jobPostingTrend,
    applicationActivity,
    roleDistribution,
    jobStatusDistribution,
  })
})

app.get("/admin/reports", adminOnly, async (req, res) => {
  const status = asString(req.query.status)
  const filter = status
    ? { status: requireEnum(status, REPORT_STATUSES, "report status") }
    : {}

  const rows = await collections.reports
    .find(filter)
    .sort({ createdAt: -1 })
    .limit(200)
    .toArray()

  const reporters = await loadUserMap(rows.map((row) => row.reporterId))
  res.json(
    rows.map((row) =>
      reportView(row, {
        reporterName: reporters.get(row.reporterId)?.name ?? null,
      })
    )
  )
})

app.post("/admin/reports", adminOnly, async (req, res) => {
  const body = req.body ?? {}
  const targetType = asString(body.targetType) ?? "job"
  const targetId = asString(body.targetId)
  const reason = sanitizeText(body.reason, 500)

  if (!targetId || !reason) {
    throw new HttpError(
      400,
      "targetId and reason are required.",
      "INVALID_REPORT"
    )
  }

  if (!["job", "user", "application"].includes(targetType)) {
    throw new HttpError(400, "Invalid report target type.", "INVALID_TARGET")
  }

  const now = new Date()
  const document = {
    targetType,
    targetId,
    targetName: sanitizeText(body.targetName, 300) ?? "Unknown target",
    reason,
    details: sanitizeText(body.details, 5000),
    status: "open",
    reporterId: req.identity.id,
    reporterName: req.user.name ?? null,
    createdAt: now,
    updatedAt: now,
    resolvedAt: null,
  }

  const result = await collections.reports.insertOne(document)
  document._id = result.insertedId

  res.status(201).json(
    reportView(document, { reporterName: document.reporterName })
  )
})

app.get("/admin/reports/:id", adminOnly, async (req, res) => {
  const objectId = toObjectId(req.params.id)
  if (!objectId) throw new HttpError(400, "Invalid report id.", "INVALID_ID")

  const report = await collections.reports.findOne({ _id: objectId })
  if (!report) throw new HttpError(404, "Report not found.", "NOT_FOUND")

  const reporter = report.reporterId
    ? await collections.users.findOne({ _id: toObjectId(report.reporterId) })
    : null

  res.json(reportView(report, { reporterName: reporter?.name ?? null }))
})

app.patch("/admin/reports/:id", adminOnly, async (req, res) => {
  const objectId = toObjectId(req.params.id)
  if (!objectId) throw new HttpError(400, "Invalid report id.", "INVALID_ID")

  const status = requireEnum(
    req.body?.status,
    REPORT_STATUSES,
    "report status"
  )

  const resolved = status === "resolved" || status === "dismissed"
  const updated = await collections.reports.findOneAndUpdate(
    { _id: objectId },
    {
      $set: {
        status,
        updatedAt: new Date(),
        resolvedAt: resolved ? new Date() : null,
      },
    },
    { returnDocument: "after" }
  )

  if (!updated) throw new HttpError(404, "Report not found.", "NOT_FOUND")

  const reporter = updated.reporterId
    ? await collections.users.findOne({ _id: toObjectId(updated.reporterId) })
    : null

  res.json(reportView(updated, { reporterName: reporter?.name ?? null }))
})

app.delete("/admin/reports/:id", adminOnly, async (req, res) => {
  const objectId = toObjectId(req.params.id)
  if (!objectId) throw new HttpError(400, "Invalid report id.", "INVALID_ID")

  const result = await collections.reports.deleteOne({ _id: objectId })
  if (result.deletedCount === 0) {
    throw new HttpError(404, "Report not found.", "NOT_FOUND")
  }

  res.status(204).end()
})

app.get("/admin/users/:id", adminOnly, async (req, res) => {
  const objectId = toObjectId(req.params.id)
  if (!objectId) throw new HttpError(400, "Invalid user id.", "INVALID_ID")

  const user = await collections.users.findOne({ _id: objectId })
  if (!user) throw new HttpError(404, "User not found.", "NOT_FOUND")

  res.json(userView(user))
})

// ---------------------------------------------------------------------------
// 6. 404, error handling and startup
// ---------------------------------------------------------------------------

app.use((_req, res) => {
  res.status(404).json({ error: "API route not found.", code: "NOT_FOUND" })
})

app.use((error, _req, res, next) => {
  if (res.headersSent) {
    next(error)
    return
  }

  let status = error instanceof HttpError ? error.status : 500
  let message =
    error instanceof HttpError
      ? error.message
      : "The server could not complete this request."
  let code = error instanceof HttpError ? error.code : "SERVER_ERROR"

  if (error?.name === "MulterError") {
    status = error.code === "LIMIT_FILE_SIZE" ? 413 : 400
    message =
      error.code === "LIMIT_FILE_SIZE"
        ? "The resume must be 5 MB or smaller."
        : "The file upload could not be processed."
    code = error.code ?? "UPLOAD_ERROR"
  }

  if (status >= 500) {
    console.error(error)
  }

  res.status(status).json({ error: message, code })
})

const server = app.listen(PORT, () => {
  console.log(`HireLoop API is running on http://localhost:${PORT}`)
})

async function shutdown(signal) {
  console.log(`${signal} received, shutting down…`)
  server.close(async () => {
    await mongoClient.close()
    process.exit(0)
  })
}

process.on("SIGINT", () => shutdown("SIGINT"))
process.on("SIGTERM", () => shutdown("SIGTERM"))

export { app, db, mongoClient }
