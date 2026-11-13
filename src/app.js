import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import multer from "multer";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { mkdir, readFile, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import { z } from "zod";
import { config } from "./config.js";
import {
  User,
  Plan,
  Purchase,
  Earning,
  Transaction,
  Deposit,
  Withdrawal,
  Setting,
} from "./models.js";
import { INSTITUTIONS } from "./catalog.js";
import {
  mountPublic,
  mountMember,
  mountAdmin,
  transactionFilter,
} from "./experience.js";
import {
  ensure,
  buyPlan,
  reviewDeposit,
  requestWithdrawal,
  reviewWithdrawal,
} from "./services.js";
export const app = express();
app.disable("x-powered-by");
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        fontSrc: ["'self'"],
        imgSrc: [
          "'self'",
          "blob:",
          "data:",
          "https://images.seeklogo.com",
          "https://www.hbl.com",
          "https://companieslogo.com",
        ],
        connectSrc: ["'self'"],
        upgradeInsecureRequests:
          process.env.NODE_ENV === "production" ? [] : null,
      },
    },
  }),
);
app.use(
  cors({
    origin: config.origin,
    allowedHeaders: ["Content-Type", "Authorization", "Idempotency-Key"],
  }),
);
app.use(express.json({ limit: "32kb" }));
app.use(
  "/api",
  rateLimit({
    windowMs: 60000,
    limit: 240,
    standardHeaders: "draft-8",
    legacyHeaders: false,
  }),
);
const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);
const parse = (schema, data) => schema.parse(data);
const id = z.string().regex(/^[a-fA-F0-9]{24}$/);
const amount = z
  .number()
  .finite()
  .positive()
  .max(10000000)
  .refine(
    (n) => Math.abs(n * 100 - Math.round(n * 100)) < 0.000001,
    "Use at most two decimal places",
  )
  .transform((n) => Math.round(n * 100));
const text = z.string().trim().min(1).max(160);
const auth = wrap(async (req, res, next) => {
  const token = req.headers.authorization?.split(" ");
  ensure(token?.[0] === "Bearer" && token[1], "Please sign in", 401);
  let p;
  try {
    p = jwt.verify(token[1], config.secret, {
      algorithms: ["HS256"],
      issuer: "robotnetwork",
      audience: "robotnetwork-web",
    });
  } catch {
    ensure(false, "Session expired. Please sign in", 401);
  }
  const u = await User.findById(p.sub);
  ensure(
    u && !u.blocked && u.tokenVersion === p.ver,
    "Session expired or account unavailable",
    401,
  );
  req.user = u;
  next();
});
const admin = (req, res, next) => {
  if (req.user.role !== "admin")
    return res.status(403).json({ message: "Administrator access required" });
  next();
};
const publicUser = (u) => ({
  _id: u._id,
  name: u.name,
  email: u.email,
  phone: u.phone,
  role: u.role,
  referralCode: u.referralCode,
  depositBalance: u.depositBalance,
  withdrawableBalance: u.withdrawableBalance,
  createdAt: u.createdAt,
});
const sign = (u) =>
  jwt.sign({ ver: u.tokenVersion }, config.secret, {
    subject: String(u._id),
    expiresIn: "12h",
    algorithm: "HS256",
    issuer: "robotnetwork",
    audience: "robotnetwork-web",
  });
const credentials = z.object({
  email: z.string().trim().toLowerCase().email().max(160),
  password: z.string().min(10).max(128),
});
const authLimiter = rateLimit({
  windowMs: 900000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
});
app.get("/api/health", (req, res) =>
  res.status(mongoose.connection.readyState === 1 ? 200 : 503).json({
    status: mongoose.connection.readyState === 1 ? "ok" : "unavailable",
  }),
);
app.get(
  "/api/public/settings",
  wrap(async (req, res) =>
    res.json(
      await Setting.findOne({ key: "payment" }).select(
        "accountName accountNumber supportEmail supportPhone -_id",
      ),
    ),
  ),
);
mountPublic(app);
app.get("/api/institutions", (req, res) => res.json(INSTITUTIONS));
app.post(
  "/api/auth/register",
  authLimiter,
  wrap(async (req, res) => {
    const d = parse(
      credentials.extend({
        name: text,
        referralCode: z.string().trim().max(24).optional(),
      }),
      req.body,
    );
    const parent = d.referralCode
      ? await User.findOne({ referralCode: d.referralCode, blocked: false })
      : null;
    ensure(!d.referralCode || parent, "Referral code is invalid");
    const u = await User.create({
      name: d.name,
      email: d.email,
      password: await bcrypt.hash(d.password, 12),
      referralCode: randomBytes(6).toString("hex").toUpperCase(),
      referredBy: parent?._id,
    });
    res.status(201).json({ token: sign(u), user: publicUser(u) });
  }),
);
app.post(
  "/api/auth/login",
  authLimiter,
  wrap(async (req, res) => {
    const d = parse(credentials, req.body);
    const u = await User.findOne({ email: d.email }).select("+password");
    const valid = await bcrypt.compare(
      d.password,
      u?.password ||
        "$2b$12$C6UzMDM.H6dfI/f/IKcEe.7F2FG4.5FfWi8JpMhi9cM.z0t0yF/2.",
    );
    ensure(u && valid && !u.blocked, "Invalid email or password", 401);
    res.json({ token: sign(u), user: publicUser(u) });
  }),
);
app.use("/api", auth);
mountMember(app);
app.get("/api/me", (req, res) => res.json(publicUser(req.user)));
app.patch(
  "/api/me",
  wrap(async (req, res) => {
    const d = parse(
      z.object({
        name: text,
        phone: z
          .string()
          .trim()
          .regex(/^[+0-9 ()-]{0,24}$/),
      }),
      req.body,
    );
    Object.assign(req.user, d);
    await req.user.save();
    res.json(publicUser(req.user));
  }),
);
app.post(
  "/api/me/password",
  wrap(async (req, res) => {
    const d = parse(
      z.object({
        currentPassword: z.string().max(128),
        newPassword: z.string().min(10).max(128),
      }),
      req.body,
    );
    const u = await User.findById(req.user._id).select("+password");
    ensure(
      await bcrypt.compare(d.currentPassword, u.password),
      "Current password is incorrect",
    );
    u.password = await bcrypt.hash(d.newPassword, 12);
    u.tokenVersion++;
    await u.save();
    res.json({ token: sign(u) });
  }),
);
app.post(
  "/api/auth/logout",
  wrap(async (req, res) => {
    await User.updateOne({ _id: req.user._id }, { $inc: { tokenVersion: 1 } });
    res.json({ message: "Signed out" });
  }),
);
app.get(
  "/api/plans",
  wrap(async (req, res) =>
    res.json(await Plan.find({ enabled: true }).sort({ price: 1 })),
  ),
);
const key = (req) =>
  parse(z.string().min(16).max(100), req.headers["idempotency-key"]);
app.post(
  "/api/purchases",
  wrap(async (req, res) => {
    const d = parse(z.object({ planId: id }), req.body);
    res.status(201).json(await buyPlan(req.user._id, d.planId, key(req)));
  }),
);
app.get(
  "/api/purchases",
  wrap(async (req, res) =>
    res.json(
      await Purchase.find({ user: req.user._id }).sort({ createdAt: -1 }),
    ),
  ),
);
const paging = (req) => {
  const p = Number(req.query.page || 1);
  ensure(Number.isInteger(p) && p > 0 && p <= 100000, "Invalid page");
  return { page: p, skip: (p - 1) * 20 };
};
async function paged(
  model,
  filter,
  req,
  res,
  sort = { createdAt: -1 },
  populate,
) {
  const { page, skip } = paging(req);
  let q = model.find(filter).sort(sort).skip(skip).limit(20);
  if (populate) q = q.populate(populate, "name email");
  const [items, total] = await Promise.all([q, model.countDocuments(filter)]);
  res.json({ items, total, page, pages: Math.ceil(total / 20) });
}
app.get(
  "/api/earnings",
  wrap((req, res) =>
    paged(Earning, { user: req.user._id }, req, res, { earnedAt: -1 }),
  ),
);
app.get(
  "/api/transactions",
  wrap((req, res) =>
    paged(
      Transaction,
      transactionFilter(
        { ...req, query: { ...req.query, user: undefined } },
        { user: req.user._id },
      ),
      req,
      res,
    ),
  ),
);
app.get(
  "/api/overview",
  wrap(async (req, res) => {
    const user = req.user._id;
    const [activePlans, earnings, commissions, recent] = await Promise.all([
      Purchase.countDocuments({ user, status: "active" }),
      Earning.aggregate([
        { $match: { user } },
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ]),
      Transaction.aggregate([
        { $match: { user, kind: "commission" } },
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ]),
      Transaction.find({ user }).sort({ createdAt: -1 }).limit(6),
    ]);
    res.json({
      user: publicUser(req.user),
      activePlans,
      totalEarnings: earnings[0]?.total || 0,
      totalCommissions: commissions[0]?.total || 0,
      recent,
    });
  }),
);
app.get(
  "/api/team",
  wrap(async (req, res) => {
    let parents = [req.user._id];
    const levels = [];
    for (let i = 1; i <= 3; i++) {
      const users = await User.find({ referredBy: { $in: parents } }).select(
        "_id name createdAt",
      );
      levels.push({
        level: i,
        rate: [12, 4, 1][i - 1],
        count: users.length,
        members: users,
      });
      parents = users.map((u) => u._id);
    }
    const commissions = await Transaction.aggregate([
      { $match: { user: req.user._id, kind: "commission" } },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]);
    res.json({
      referralCode: req.user.referralCode,
      levels,
      totalCommissions: commissions[0]?.total || 0,
    });
  }),
);
const uploadDir = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : fileURLToPath(new URL("../uploads/", import.meta.url));
await mkdir(uploadDir, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, cb) => cb(null, randomBytes(24).toString("hex")),
  }),
  limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 4 },
  fileFilter: (req, file, cb) =>
    cb(null, ["image/png", "image/jpeg", "image/webp"].includes(file.mimetype)),
});
app.post(
  "/api/deposits",
  upload.single("screenshot"),
  wrap(async (req, res) => {
    try {
      const d = parse(
        z.object({
          amount: z.coerce.number().pipe(amount),
          tid: z
            .string()
            .trim()
            .toUpperCase()
            .regex(/^[A-Z0-9-]{5,80}$/),
        }),
        req.body,
      );
      ensure(req.file, "A PNG, JPEG or WebP screenshot up to 5MB is required");
      const b = await readFile(req.file.path);
      const valid =
        req.file.mimetype === "image/png"
          ? b
              .subarray(0, 8)
              .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          : req.file.mimetype === "image/jpeg"
            ? b[0] === 255 && b[1] === 216 && b[2] === 255
            : b.subarray(0, 4).toString() === "RIFF" &&
              b.subarray(8, 12).toString() === "WEBP";
      ensure(valid, "Screenshot format does not match its contents");
      const deposit = await Deposit.create({
        user: req.user._id,
        ...d,
        screenshot: req.file.filename,
        mime: req.file.mimetype,
      });
      res.status(201).json(deposit);
    } catch (e) {
      if (req.file) await unlink(req.file.path).catch(() => {});
      throw e;
    }
  }),
);
app.get(
  "/api/deposits",
  wrap((req, res) => {
    const status = z
      .enum(["pending", "approved", "rejected"])
      .optional()
      .parse(req.query.status);
    return paged(
      Deposit,
      { user: req.user._id, ...(status ? { status } : {}) },
      req,
      res,
    );
  }),
);
app.get(
  "/api/deposits/:id/proof",
  wrap(async (req, res) => {
    const d = await Deposit.findById(parse(id, req.params.id));
    ensure(
      d &&
        (req.user.role === "admin" || String(d.user) === String(req.user._id)),
      "Proof not found",
      404,
    );
    res.set("Cache-Control", "no-store");
    res.type(d.mime).sendFile(path.join(uploadDir, d.screenshot));
  }),
);
app.post(
  "/api/withdrawals",
  wrap(async (req, res) => {
    const d = parse(
      z.object({
        amount: amount.refine(
          (n) => n >= 10000,
          "Minimum withdrawal is Rs 100",
        ),
        institution: z.enum(INSTITUTIONS.map((i) => i.id)),
        customInstitution: z.string().trim().max(160).default(""),
        accountName: text,
        accountNumber: z
          .string()
          .trim()
          .regex(/^[A-Za-z0-9 -]{6,40}$/),
      }),
      req.body,
    );
    ensure(
      d.institution !== "other" || d.customInstitution.length > 2,
      "Enter your bank or wallet name",
    );
    res.status(201).json(await requestWithdrawal(req.user._id, d, key(req)));
  }),
);
app.get(
  "/api/withdrawals",
  wrap((req, res) => {
    const status = z
      .enum(["pending", "paid", "rejected"])
      .optional()
      .parse(req.query.status);
    return paged(
      Withdrawal,
      { user: req.user._id, ...(status ? { status } : {}) },
      req,
      res,
    );
  }),
);
app.use("/api/admin", admin);
mountAdmin(app);
app.get(
  "/api/admin/overview",
  wrap(async (req, res) => {
    const [users, activePlans, deposits, withdrawals, balances, byDay] =
      await Promise.all([
        User.countDocuments({ role: "member" }),
        Purchase.countDocuments({ status: "active" }),
        Deposit.countDocuments({ status: "pending" }),
        Withdrawal.countDocuments({ status: "pending" }),
        User.aggregate([
          {
            $group: {
              _id: null,
              deposits: { $sum: "$depositBalance" },
              withdrawable: { $sum: "$withdrawableBalance" },
            },
          },
        ]),
        Transaction.aggregate([
          {
            $match: {
              createdAt: { $gte: new Date(Date.now() - 30 * 86400000) },
              kind: { $in: ["deposit", "withdrawal", "refund"] },
            },
          },
          {
            $group: {
              _id: {
                $dateToString: {
                  format: "%Y-%m-%d",
                  date: "$createdAt",
                  timezone: "Asia/Karachi",
                },
              },
              deposits: {
                $sum: { $cond: [{ $eq: ["$kind", "deposit"] }, "$amount", 0] },
              },
              withdrawals: {
                $sum: {
                  $switch: {
                    branches: [
                      {
                        case: { $eq: ["$kind", "withdrawal"] },
                        then: "$amount",
                      },
                      {
                        case: { $eq: ["$kind", "refund"] },
                        then: { $multiply: ["$amount", -1] },
                      },
                    ],
                    default: 0,
                  },
                },
              },
            },
          },
          { $sort: { _id: 1 } },
        ]),
      ]);
    res.json({
      users,
      activePlans,
      pendingDeposits: deposits,
      pendingWithdrawals: withdrawals,
      balances: balances[0] || { deposits: 0, withdrawable: 0 },
      chart: byDay.map((d) => ({
        date: d._id,
        deposits: d.deposits / 100,
        withdrawals: d.withdrawals / 100,
      })),
    });
  }),
);
app.get(
  "/api/admin/users",
  wrap(async (req, res) => {
    const { page, skip } = paging(req);
    const q = z.string().trim().max(160).optional().parse(req.query.q);
    const escaped = q?.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const filter = q
      ? {
          $or: [
            { name: { $regex: escaped, $options: "i" } },
            { email: { $regex: escaped, $options: "i" } },
          ],
        }
      : {};
    const [items, total] = await Promise.all([
      User.find(filter)
        .select("-tokenVersion")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(20),
      User.countDocuments(filter),
    ]);
    res.json({ items, total, page, pages: Math.ceil(total / 20) });
  }),
);
app.patch(
  "/api/admin/users/:id",
  wrap(async (req, res) => {
    const d = parse(z.object({ blocked: z.boolean() }), req.body);
    ensure(
      String(req.user._id) !== req.params.id,
      "You cannot block your own account",
    );
    const u = await User.findOneAndUpdate(
      { _id: parse(id, req.params.id), role: "member" },
      { $set: d, $inc: { tokenVersion: 1 } },
      { new: true },
    );
    ensure(u, "Member not found", 404);
    res.json(u);
  }),
);
app.get(
  "/api/admin/plans",
  wrap(async (req, res) => res.json(await Plan.find().sort({ price: 1 }))),
);
app.patch(
  "/api/admin/plans/:id",
  wrap(async (req, res) => {
    const d = parse(
      z
        .object({
          enabled: z.boolean().optional(),
          name: text.optional(),
          description: z.string().trim().max(500).optional(),
        })
        .refine((v) => Object.keys(v).length > 0, "No changes supplied"),
      req.body,
    );
    const p = await Plan.findByIdAndUpdate(
      parse(id, req.params.id),
      { $set: d },
      { new: true },
    );
    ensure(p, "Plan not found", 404);
    res.json(p);
  }),
);
for (const [route, model] of [
  ["deposits", Deposit],
  ["withdrawals", Withdrawal],
]) {
  app.get(
    `/api/admin/${route}`,
    wrap((req, res) => {
      const status = req.query.status;
      ensure(
        !status ||
          (route === "deposits"
            ? ["pending", "approved", "rejected"]
            : ["pending", "paid", "rejected"]
          ).includes(status),
        "Invalid status",
      );
      return paged(
        model,
        status ? { status } : {},
        req,
        res,
        { createdAt: -1 },
        "user",
      );
    }),
  );
  app.post(
    `/api/admin/${route}/:id/review`,
    wrap(async (req, res) => {
      const d = parse(
        z.object({
          action: z.enum(
            route === "deposits"
              ? ["approved", "rejected"]
              : ["paid", "rejected"],
          ),
          note: z.string().trim().max(500).default(""),
        }),
        req.body,
      );
      const result = await (
        route === "deposits" ? reviewDeposit : reviewWithdrawal
      )(parse(id, req.params.id), req.user._id, d.action, d.note);
      res.json(result);
    }),
  );
}
app.get(
  "/api/admin/settings",
  wrap(async (req, res) => res.json(await Setting.findOne({ key: "payment" }))),
);
app.patch(
  "/api/admin/settings",
  wrap(async (req, res) => {
    const d = parse(
      z.object({
        accountName: text,
        accountNumber: z.string().regex(/^03[0-9]{9}$/),
        supportEmail: z.union([z.literal(""), z.string().email().max(160)]),
        supportPhone: z.string().regex(/^[+0-9 ()-]{7,24}$/),
      }),
      req.body,
    );
    res.json(
      await Setting.findOneAndUpdate(
        { key: "payment" },
        { $set: d },
        { new: true, runValidators: true },
      ),
    );
  }),
);
app.use("/api", (req, res) =>
  res.status(404).json({ message: "API route not found" }),
);
const dist = fileURLToPath(new URL("../../frontend/dist/", import.meta.url));
app.use(express.static(dist));
app.get("/{*path}", (req, res, next) =>
  res.sendFile(path.join(dist, "index.html"), (e) => e && next(e)),
);
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status =
    err instanceof z.ZodError
      ? 400
      : err.code === 11000
        ? 409
        : err instanceof multer.MulterError
          ? 400
          : err.status || 500;
  const message =
    err instanceof z.ZodError
      ? err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
      : err.code === 11000
        ? "This record already exists. Refresh to see its current status."
        : status === 500
          ? "Unable to complete this request"
          : err.message;
  if (status === 500) console.error(err);
  res.status(status).json({ message });
});
