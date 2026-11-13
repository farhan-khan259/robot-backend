import mongoose from "mongoose";
import { z } from "zod";
import {
  User,
  Plan,
  Purchase,
  Transaction,
  Deposit,
  Withdrawal,
  Earning,
} from "./models.js";
import { ensure } from "./services.js";
const { Schema, model } = mongoose;
export const DEFAULT_CONTENT = {
  key: "site",
  heroTitle: "A clearer view of your next chapter.",
  heroSubtitle:
    "Your plans, your earnings, and your network — thoughtfully connected in one workspace.",
  announcementEnabled: false,
  announcementTitle: "",
  announcementBody: "",
  announcementLink: "",
  faqs: [
    {
      category: "Plans",
      question: "When are plan earnings credited?",
      answer:
        "Day 1 is credited immediately on purchase. Days 2–45 follow at 24-hour intervals, processed by the scheduler every minute. The final credit reconciles the exact total shown on your plan.",
    },
    {
      category: "Wallets",
      question: "Can I withdraw my deposit balance?",
      answer:
        "Deposit balance is reserved for plan purchases. Only plan earnings and approved deposit referral commissions enter your withdrawable wallet.",
    },
    {
      category: "Payments",
      question: "How do manual deposits work?",
      answer:
        "Transfer to the Easypaisa account shown on the deposit page. Submit the amount, transaction ID and screenshot. An administrator verifies the transfer before crediting your deposit wallet.",
    },
    {
      category: "Payments",
      question: "What happens after a withdrawal request?",
      answer:
        "The requested amount is reserved immediately. An administrator pays your nominated bank or wallet manually and marks the request paid. Rejected requests return the reserved amount to your withdrawable wallet.",
    },
    {
      category: "Network",
      question: "How do referral commissions work?",
      answer:
        "Approved deposits pay three levels of commissions: 12%, 4% and 1%. Daily plan earnings do not generate team commissions.",
    },
    {
      category: "Payments",
      question: "When can I request a withdrawal?",
      answer:
        "Requests are available 24/7, require an active plan, and have a minimum amount of Rs 200.",
    },
  ],
};
export const Content = model(
  "Content",
  new Schema(
    {
      key: { type: String, unique: true },
      heroTitle: String,
      heroSubtitle: String,
      announcementEnabled: Boolean,
      announcementTitle: String,
      announcementBody: String,
      announcementLink: String,
      faqs: [
        { category: String, question: String, answer: String, _id: false },
      ],
    },
    { timestamps: true, strict: "throw" },
  ),
);
export const Ticket = model(
  "Ticket",
  new Schema(
    {
      user: { type: Schema.Types.ObjectId, ref: "User", required: true },
      subject: { type: String, required: true },
      category: {
        type: String,
        enum: ["account", "deposit", "withdrawal", "plan", "other"],
        required: true,
      },
      status: { type: String, enum: ["open", "closed"], default: "open" },
      messages: [
        {
          author: { type: Schema.Types.ObjectId, ref: "User", required: true },
          role: { type: String, enum: ["member", "admin"], required: true },
          body: { type: String, required: true },
          createdAt: { type: Date, default: Date.now },
        },
      ],
    },
    { timestamps: true, strict: "throw" },
  ),
);
Ticket.schema.index({ user: 1, createdAt: -1 });
const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);
const objectId = z.string().regex(/^[a-fA-F0-9]{24}$/);
function page(req) {
  const n = Number(req.query.page || 1);
  ensure(Number.isInteger(n) && n > 0 && n <= 100000, "Invalid page");
  return n;
}
async function list(
  model,
  filter,
  req,
  res,
  { populate, select, sort = { createdAt: -1 } } = {},
) {
  const n = page(req);
  let query = model
    .find(filter)
    .sort(sort)
    .skip((n - 1) * 20)
    .limit(20);
  if (populate) query = query.populate(populate, "name email");
  if (select) query = query.select(select);
  const [items, total] = await Promise.all([
    query,
    model.countDocuments(filter),
  ]);
  res.json({ items, total, page: n, pages: Math.ceil(total / 20) });
}
const kinds = [
  "deposit",
  "purchase",
  "earning",
  "commission",
  "withdrawal",
  "refund",
];
export function transactionFilter(req, extra = {}) {
  const f = { ...extra };
  if (req.query.kind) {
    ensure(kinds.includes(req.query.kind), "Invalid transaction kind");
    f.kind = req.query.kind;
  }
  if (req.query.user)
    f.user = new mongoose.Types.ObjectId(objectId.parse(req.query.user));
  if (req.query.from || req.query.to) {
    const d = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
      const candidate = new Date(value + "T00:00:00Z");
      return !isNaN(+candidate) && candidate.toISOString().slice(0, 10) === value;
    }, "Use a valid calendar date");
    f.createdAt = {};
    if (req.query.from) {
      const value = d.parse(req.query.from);
      const date = new Date(value + "T00:00:00+05:00");
      ensure(!isNaN(+date), "Invalid start date");
      f.createdAt.$gte = date;
    }
    if (req.query.to) {
      const value = d.parse(req.query.to);
      const date = new Date(value + "T00:00:00+05:00");
      ensure(!isNaN(+date), "Invalid end date");
      f.createdAt.$lt = new Date(+date + 86400000);
    }
    if (f.createdAt.$gte && f.createdAt.$lt)
      ensure(
        f.createdAt.$gte < f.createdAt.$lt,
        "Start date must precede end date",
      );
  }
  return f;
}
export async function getContent() {
  return Content.findOneAndUpdate(
    { key: "site" },
    { $setOnInsert: DEFAULT_CONTENT },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );
}
export function mountPublic(app) {
  app.get(
    "/api/public/content",
    wrap(async (req, res) => res.json(await getContent())),
  );
}
export function mountMember(app) {
  app.get(
    "/api/plans/:id",
    wrap(async (req, res) => {
      const p = await Plan.findOne({
        _id: objectId.parse(req.params.id),
        enabled: true,
      });
      ensure(p, "Plan is unavailable", 404);
      res.json(p);
    }),
  );
  app.get(
    "/api/me/summary",
    wrap(async (req, res) => {
      const user = req.user._id;
      const [deposits, withdrawals, plans, inviter] = await Promise.all([
        Deposit.aggregate([
          { $match: { user } },
          {
            $group: {
              _id: "$status",
              amount: { $sum: "$amount" },
              count: { $sum: 1 },
            },
          },
        ]),
        Withdrawal.aggregate([
          { $match: { user } },
          {
            $group: {
              _id: "$status",
              amount: { $sum: "$amount" },
              count: { $sum: 1 },
            },
          },
        ]),
        Purchase.find({ user, status: "active" })
          .sort({ nextCreditAt: 1 })
          .limit(3),
        req.user.referredBy
          ? User.findById(req.user.referredBy).select("name createdAt")
          : null,
      ]);
      res.json({ deposits, withdrawals, plans, inviter });
    }),
  );
  app.get(
    "/api/notifications",
    wrap(async (req, res) => {
      const [d, w] = await Promise.all([
        Deposit.find({ user: req.user._id }).sort({ updatedAt: -1 }).limit(20),
        Withdrawal.find({ user: req.user._id })
          .sort({ updatedAt: -1 })
          .limit(20),
      ]);
      const items = [
        ...d.map((x) => ({
          _id: `deposit:${x._id}:${x.status}`,
          title: `Deposit ${x.status}`,
          body: `${(x.amount / 100).toLocaleString("en-PK")} PKR · ${x.note || "Your payment request is recorded."}`,
          at: x.reviewedAt || x.createdAt,
          link: "/deposits/history",
        })),
        ...w.map((x) => ({
          _id: `withdrawal:${x._id}:${x.status}`,
          title: `Withdrawal ${x.status}`,
          body: `${(x.amount / 100).toLocaleString("en-PK")} PKR · ${x.note || (x.status === "pending" ? "Funds reserved for manual review." : x.status === "paid" ? "Payment marked completed by the administrator." : "Reserved funds returned to your wallet.")}`,
          at: x.reviewedAt || x.createdAt,
          link: "/withdrawals/history",
        })),
      ]
        .sort((a, b) => +b.at - +a.at)
        .slice(0, 40)
        .map((x) => ({
          ...x,
          read: req.user.notificationsReadAt
            ? x.at <= req.user.notificationsReadAt
            : false,
        }));
      res.json({ items, unread: items.filter((x) => !x.read).length });
    }),
  );
  app.post(
    "/api/notifications/read",
    wrap(async (req, res) => {
      await User.updateOne(
        { _id: req.user._id },
        { $set: { notificationsReadAt: new Date() } },
      );
      res.json({ message: "Notifications marked as read" });
    }),
  );
  app.get(
    "/api/tickets",
    wrap((req, res) =>
      list(Ticket, { user: req.user._id }, req, res, { select: "-messages" }),
    ),
  );
  app.post(
    "/api/tickets",
    wrap(async (req, res) => {
      const d = z
        .object({
          subject: z.string().trim().min(3).max(160),
          category: z.enum([
            "account",
            "deposit",
            "withdrawal",
            "plan",
            "other",
          ]),
          message: z.string().trim().min(5).max(4000),
        })
        .parse(req.body);
      res
        .status(201)
        .json(
          await Ticket.create({
            user: req.user._id,
            subject: d.subject,
            category: d.category,
            messages: [
              { author: req.user._id, role: req.user.role, body: d.message },
            ],
          }),
        );
    }),
  );
  app.get(
    "/api/tickets/:id",
    wrap(async (req, res) => {
      const t = await Ticket.findOne({
        _id: objectId.parse(req.params.id),
        user: req.user._id,
      });
      ensure(t, "Ticket not found", 404);
      res.json(t);
    }),
  );
  app.post(
    "/api/tickets/:id/replies",
    wrap(async (req, res) => {
      const { message } = z
        .object({ message: z.string().trim().min(1).max(4000) })
        .parse(req.body);
      const t = await Ticket.findOneAndUpdate(
        {
          _id: objectId.parse(req.params.id),
          user: req.user._id,
          status: "open",
        },
        {
          $push: {
            messages: {
              author: req.user._id,
              role: req.user.role,
              body: message,
              createdAt: new Date(),
            },
          },
        },
        { new: true, runValidators: true },
      );
      ensure(t, "Ticket is closed or unavailable", 409);
      res.json(t);
    }),
  );
}
export function mountAdmin(app) {
  app.get(
    "/api/admin/transactions/export",
    wrap(async (req, res) => {
      const filter = transactionFilter(req);
      const cell = (v) => {
        let str = String(v ?? "");
        if (/^[=+\-@\t\r]/.test(str)) str = "'" + str;
        return '"' + str.replaceAll('"', '""') + '"';
      };
      res
        .type("text/csv")
        .set(
          "Content-Disposition",
          'attachment; filename="robotnetwork-ledger.csv"',
        );
      res.write(
        "Reference,Date,Member,Email,Kind,Wallet,Direction,Amount PKR,Note\r\n",
      );
      const cursor = Transaction.find(filter)
        .sort({ createdAt: -1 })
        .populate("user", "name email")
        .cursor();
      for await (const t of cursor) {
        if (res.destroyed) {
          await cursor.close();
          break;
        }
        const row =
          [
            t.reference,
            t.createdAt.toISOString(),
            t.user?.name,
            t.user?.email,
            t.kind,
            t.wallet,
            t.direction,
            (t.amount / 100).toFixed(2),
            t.note,
          ]
            .map(cell)
            .join(",") + "\r\n";
        if (!res.write(row))
          await new Promise((resolve) => {
            const done = () => {
              res.off("drain", done);
              res.off("close", done);
              resolve();
            };
            res.once("drain", done);
            res.once("close", done);
          });
      }
      res.end();
    }),
  );
  app.get(
    "/api/admin/transactions",
    wrap((req, res) =>
      list(Transaction, transactionFilter(req), req, res, { populate: "user" }),
    ),
  );
  app.get(
    "/api/admin/commissions",
    wrap(async (req, res) => {
      const totals = await Transaction.aggregate([
        { $match: { kind: "commission" } },
        {
          $group: {
            _id: { $arrayElemAt: [{ $split: ["$reference", ":"] }, 1] },
            total: { $sum: "$amount" },
            count: { $sum: 1 },
          },
        },
      ]);
      res.json({
        levels: [1, 2, 3].map((level) => ({
          level,
          rate: [12, 4, 1][level - 1],
          total: totals.find((x) => x._id === String(level))?.total || 0,
          count: totals.find((x) => x._id === String(level))?.count || 0,
        })),
        total: totals.reduce((s, x) => s + x.total, 0),
      });
    }),
  );
  app.get(
    "/api/admin/reports",
    wrap(async (req, res) => {
      const [flow, earnings, requests, purchases] = await Promise.all([
        Transaction.aggregate([
          {
            $group: {
              _id: {
                kind: "$kind",
                wallet: "$wallet",
                direction: "$direction",
              },
              amount: { $sum: "$amount" },
              count: { $sum: 1 },
            },
          },
        ]),
        Earning.aggregate([
          {
            $group: {
              _id: null,
              paid: { $sum: "$amount" },
              credits: { $sum: 1 },
            },
          },
        ]),
        Withdrawal.aggregate([
          {
            $group: {
              _id: "$status",
              amount: { $sum: "$amount" },
              count: { $sum: 1 },
            },
          },
        ]),
        Purchase.aggregate([
          {
            $group: {
              _id: "$status",
              count: { $sum: 1 },
              purchased: { $sum: "$price" },
              paid: { $sum: "$paid" },
            },
          },
        ]),
      ]);
      res.json({
        flow,
        earnings: earnings[0] || { paid: 0, credits: 0 },
        requests,
        purchases,
      });
    }),
  );
  app.get(
    "/api/admin/users/:id/detail",
    wrap(async (req, res) => {
      const user = await User.findById(objectId.parse(req.params.id))
        .select("-tokenVersion")
        .populate("referredBy", "name email referralCode");
      ensure(user, "Member not found", 404);
      const [plans, transactions] = await Promise.all([
        Purchase.find({ user: user._id }).sort({ createdAt: -1 }).limit(30),
        Transaction.find({ user: user._id }).sort({ createdAt: -1 }).limit(20),
      ]);
      res.json({ user, plans, transactions });
    }),
  );
  app.get(
    "/api/admin/content",
    wrap(async (req, res) => res.json(await getContent())),
  );
  app.patch(
    "/api/admin/content",
    wrap(async (req, res) => {
      const short = z.string().trim().min(1).max(160),
        long = z.string().trim().min(1).max(2000);
      const d = z
        .object({
          heroTitle: short,
          heroSubtitle: long,
          announcementEnabled: z.boolean(),
          announcementTitle: z.string().trim().max(160),
          announcementBody: z.string().trim().max(2000),
          announcementLink: z
            .string()
            .trim()
            .max(200)
            .refine(
              (v) => !v || /^\/(?!\/)[A-Za-z0-9/?#=&%._~-]*$/.test(v),
              "Use an internal page path",
            ),
          faqs: z
            .array(z.object({ category: short, question: short, answer: long }))
            .min(1)
            .max(30),
        })
        .parse(req.body);
      ensure(
        !d.announcementEnabled || (d.announcementTitle && d.announcementBody),
        "An enabled announcement needs a title and message",
      );
      res.json(
        await Content.findOneAndUpdate(
          { key: "site" },
          { $set: d },
          { new: true, upsert: true, runValidators: true },
        ),
      );
    }),
  );
  app.get(
    "/api/admin/tickets",
    wrap((req, res) => {
      const status = req.query.status;
      ensure(
        !status || ["open", "closed"].includes(status),
        "Invalid ticket status",
      );
      return list(Ticket, status ? { status } : {}, req, res, {
        populate: "user",
        select: "-messages",
      });
    }),
  );
  app.get(
    "/api/admin/tickets/:id",
    wrap(async (req, res) => {
      const t = await Ticket.findById(objectId.parse(req.params.id)).populate(
        "user",
        "name email",
      );
      ensure(t, "Ticket not found", 404);
      res.json(t);
    }),
  );
  app.post(
    "/api/admin/tickets/:id/replies",
    wrap(async (req, res) => {
      const { message } = z
        .object({ message: z.string().trim().min(1).max(4000) })
        .parse(req.body);
      const t = await Ticket.findOneAndUpdate(
        { _id: objectId.parse(req.params.id), status: "open" },
        {
          $push: {
            messages: {
              author: req.user._id,
              role: "admin",
              body: message,
              createdAt: new Date(),
            },
          },
        },
        { new: true, runValidators: true },
      );
      ensure(t, "Ticket is closed or unavailable", 409);
      res.json(t);
    }),
  );
  app.patch(
    "/api/admin/tickets/:id",
    wrap(async (req, res) => {
      const { status } = z
        .object({ status: z.enum(["open", "closed"]) })
        .parse(req.body);
      const t = await Ticket.findByIdAndUpdate(
        objectId.parse(req.params.id),
        { $set: { status } },
        { new: true, runValidators: true },
      );
      ensure(t, "Ticket not found", 404);
      res.json(t);
    }),
  );
}
