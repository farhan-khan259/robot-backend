import mongoose from "mongoose";
import {
  User,
  Plan,
  Purchase,
  Earning,
  Transaction,
  Deposit,
  Withdrawal,
  Setting,
  models,
} from "./models.js";
import { PLAN_DATA, DAY, payoutForDay } from "./catalog.js";
export function ensure(condition, message, status = 400) {
  if (!condition) {
    const e = new Error(message);
    e.status = status;
    throw e;
  }
}
export async function atomic(fn) {
  return mongoose.connection.transaction(fn);
}
export async function initialize() {
  const hello = await mongoose.connection.db.admin().command({ hello: 1 });
  ensure(
    hello.setName || hello.msg === "isdbgrid",
    "MongoDB replica set is required for atomic financial operations",
    500,
  );
  await User.createCollection().catch((error) => {
    if (error.codeName !== "NamespaceExists") throw error;
  });
  await User.updateMany({ phone: "" }, { $unset: { phone: 1 } });
  const indexes = await User.collection.listIndexes().toArray();
  for (const index of indexes) {
    if (
      index.name !== "_id_" &&
      (index.key?.email === 1 || index.key?.phone === 1)
    ) {
      await User.collection.dropIndex(index.name);
    }
  }
  await Promise.all(models.map((m) => m.init()));
  await User.collection.createIndex(
    { phone: 1 },
    { unique: true, sparse: true, name: "phone_1" },
  );
  for (const p of PLAN_DATA) {
    const { name, ...initialPlan } = p;
    await Plan.updateOne(
      { code: p.code },
      { $set: { name }, $setOnInsert: initialPlan },
      { upsert: true },
    );
  }
  await Setting.updateOne(
    { key: "payment" },
    {
      $setOnInsert: {
        key: "payment",
        accountName: "Kashif Ali",
        accountNumber: "03248008331",
        supportPhone: "03248008331",
      },
    },
    { upsert: true },
  );
  await Setting.updateOne(
    { key: "payment", accountName: "Muhammad Farhan" },
    { $set: { accountName: "Kashif Ali" } },
  );
  await Setting.updateOne(
    { key: "payment", accountNumber: "03340490934" },
    { $set: { accountNumber: "03248008331" } },
  );
  await Setting.updateOne(
    { key: "payment", supportPhone: "03340490934" },
    { $set: { supportPhone: "03248008331" } },
  );
}
export async function ledger(
  session,
  user,
  kind,
  amount,
  direction,
  wallet,
  reference,
  note,
) {
  await Transaction.create(
    [
      {
        user,
        kind,
        amount,
        direction,
        wallet,
        reference: String(reference),
        note,
      },
    ],
    { session },
  );
}
export async function creditDay(session, p, at) {
  const day = p.creditedDays + 1,
    amount = payoutForDay(p, day);
  await Earning.create(
    [{ user: p.user, purchase: p._id, day, amount, earnedAt: at }],
    { session },
  );
  await User.updateOne(
    { _id: p.user },
    { $inc: { withdrawableBalance: amount } },
    { session },
  );
  await ledger(
    session,
    p.user,
    "earning",
    amount,
    "in",
    "withdrawable",
    `${p._id}:${day}`,
    `${p.name} · Day ${day}`,
  );
  p.creditedDays = day;
  p.paid += amount;
  p.status = day === p.duration ? "completed" : "active";
  p.nextCreditAt = day === p.duration ? null : new Date(+at + DAY);
  await p.save({ session });
}
export async function buyPlan(userId, planId, requestKey) {
  return atomic(async (session) => {
    const old = await Purchase.findOne({ user: userId, requestKey }).session(
      session,
    );
    if (old) return old;
    const plan = await Plan.findOne({ _id: planId, enabled: true }).session(
      session,
    );
    ensure(plan, "Plan is unavailable", 404);
    const user = await User.findOneAndUpdate(
      { _id: userId, blocked: false, depositBalance: { $gte: plan.price } },
      { $inc: { depositBalance: -plan.price } },
      { new: true, session },
    );
    ensure(user, "Insufficient deposit balance");
    const [p] = await Purchase.create(
      [
        {
          user: userId,
          plan: plan._id,
          name: plan.name,
          price: plan.price,
          daily: plan.daily,
          total: plan.total,
          duration: plan.duration,
          requestKey,
        },
      ],
      { session },
    );
    await ledger(
      session,
      userId,
      "purchase",
      plan.price,
      "out",
      "deposit",
      p._id,
      `${plan.name} activated`,
    );
    await creditDay(session, p, p.createdAt);
    return p;
  });
}
export async function reviewDeposit(id, admin, action, note) {
  return atomic(async (session) => {
    const d = await Deposit.findById(id).session(session);
    ensure(d, "Deposit not found", 404);
    ensure(d.status === "pending", "Deposit has already been reviewed", 409);
    d.status = action;
    d.reviewer = admin;
    d.reviewedAt = new Date();
    d.note = note;
    await d.save({ session });
    if (action === "approved") {
      const owner = await User.findByIdAndUpdate(
        d.user,
        { $inc: { depositBalance: d.amount } },
        { new: true, session },
      );
      ensure(owner, "Member no longer exists", 404);
      await ledger(
        session,
        d.user,
        "deposit",
        d.amount,
        "in",
        "deposit",
        d._id,
        "Easypaisa deposit approved",
      );
      let parent = owner.referredBy;
      for (const [i, percent] of [12, 4, 1].entries()) {
        if (!parent) break;
        const u = await User.findById(parent).session(session);
        if (!u) break;
        const commission = Math.floor((d.amount * percent) / 100);
        if (commission) {
          await User.updateOne(
            { _id: u._id },
            { $inc: { withdrawableBalance: commission } },
            { session },
          );
          await ledger(
            session,
            u._id,
            "commission",
            commission,
            "in",
            "withdrawable",
            `${d._id}:${i + 1}`,
            `Level ${i + 1} deposit commission (${percent}%)`,
          );
        }
        parent = u.referredBy;
      }
    }
    return d;
  });
}
export async function requestWithdrawal(userId, data, requestKey) {
  return atomic(async (session) => {
    const old = await Withdrawal.findOne({ user: userId, requestKey }).session(
      session,
    );
    if (old) return old;
    ensure(
      await Purchase.exists({
        user: userId,
        status: "active",
        createdAt: { $gt: new Date(Date.now() - 45 * DAY) },
      }).session(session),
      "An active plan is required",
    );
    const u = await User.findOneAndUpdate(
      {
        _id: userId,
        blocked: false,
        withdrawableBalance: { $gte: data.amount },
      },
      { $inc: { withdrawableBalance: -data.amount } },
      { new: true, session },
    );
    ensure(u, "Insufficient withdrawable wallet funds");
    const [w] = await Withdrawal.create(
      [{ user: userId, ...data, requestKey }],
      { session },
    );
    await ledger(
      session,
      userId,
      "withdrawal",
      w.amount,
      "out",
      "withdrawable",
      w._id,
      "Withdrawal reserved for manual payment",
    );
    return w;
  });
}
export async function reviewWithdrawal(id, admin, action, note) {
  return atomic(async (session) => {
    const w = await Withdrawal.findById(id).session(session);
    ensure(w, "Withdrawal not found", 404);
    ensure(w.status === "pending", "Withdrawal has already been reviewed", 409);
    w.status = action;
    w.reviewer = admin;
    w.reviewedAt = new Date();
    w.note = note;
    await w.save({ session });
    if (action === "rejected") {
      await User.updateOne(
        { _id: w.user },
        { $inc: { withdrawableBalance: w.amount } },
        { session },
      );
      await ledger(
        session,
        w.user,
        "refund",
        w.amount,
        "in",
        "withdrawable",
        w._id,
        "Rejected withdrawal refunded",
      );
    }
    return w;
  });
}
export async function runEarnings(now = new Date()) {
  const cursor = Purchase.find({
    status: "active",
    nextCreditAt: { $lte: now },
  })
    .select("_id")
    .cursor();
  for await (const item of cursor) {
    await atomic(async (session) => {
      const p = await Purchase.findById(item._id).session(session);
      while (p && p.status === "active" && p.nextCreditAt <= now)
        await creditDay(session, p, p.nextCreditAt);
    });
  }
}
