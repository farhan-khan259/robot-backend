import mongoose from "mongoose";
const { Schema, model } = mongoose;
const money = {
  type: Number,
  min: 0,
  required: true,
  validate: Number.isSafeInteger,
};
const ref = (target, extra = {}) => ({
  type: Schema.Types.ObjectId,
  ref: target,
  ...extra,
});
const options = { timestamps: true, strict: "throw" };
const userSchema = new Schema(
  {
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true, select: false },
    role: { type: String, enum: ["member", "admin"], default: "member" },
    referralCode: { type: String, required: true, unique: true },
    referredBy: ref("User"),
    depositBalance: { ...money, default: 0 },
    withdrawableBalance: { ...money, default: 0 },
    blocked: { type: Boolean, default: false },
    tokenVersion: { type: Number, default: 0 },
    phone: { type: String, default: "" },
    notificationsReadAt: { type: Date, default: null },
  },
  options,
);
export const User = model("User", userSchema);
export const Plan = model(
  "Plan",
  new Schema(
    {
      code: { type: String, unique: true, required: true },
      name: { type: String, required: true },
      price: money,
      daily: money,
      total: money,
      duration: { type: Number, default: 45 },
      enabled: { type: Boolean, default: true },
      description: { type: String, default: "" },
    },
    options,
  ),
);
const purchaseSchema = new Schema(
  {
    user: ref("User", { required: true }),
    plan: ref("Plan", { required: true }),
    name: String,
    price: money,
    daily: money,
    total: money,
    duration: Number,
    creditedDays: { type: Number, default: 0 },
    paid: { ...money, default: 0 },
    nextCreditAt: Date,
    status: { type: String, enum: ["active", "completed"], default: "active" },
    requestKey: { type: String, required: true },
  },
  options,
);
purchaseSchema.index({ user: 1, requestKey: 1 }, { unique: true });
purchaseSchema.index({ status: 1, nextCreditAt: 1 });
export const Purchase = model("Purchase", purchaseSchema);
const earningSchema = new Schema(
  {
    user: ref("User", { required: true }),
    purchase: ref("Purchase", { required: true }),
    day: { type: Number, required: true },
    amount: money,
    earnedAt: { type: Date, required: true },
  },
  options,
);
earningSchema.index({ purchase: 1, day: 1 }, { unique: true });
export const Earning = model("Earning", earningSchema);
const txSchema = new Schema(
  {
    user: ref("User", { required: true }),
    kind: {
      type: String,
      enum: [
        "deposit",
        "purchase",
        "earning",
        "commission",
        "adjustment",
        "withdrawal",
        "refund",
      ],
      required: true,
    },
    amount: money,
    direction: { type: String, enum: ["in", "out"], required: true },
    wallet: { type: String, enum: ["deposit", "withdrawable"], required: true },
    reference: { type: String, required: true },
    note: { type: String, required: true },
  },
  options,
);
txSchema.index({ user: 1, kind: 1, reference: 1 }, { unique: true });
export const Transaction = model("Transaction", txSchema);
export const Deposit = model(
  "Deposit",
  new Schema(
    {
      user: ref("User", { required: true }),
      amount: money,
      tid: { type: String, required: true, unique: true },
      screenshot: { type: String, required: true },
      mime: { type: String, required: true },
      status: {
        type: String,
        enum: ["pending", "approved", "rejected"],
        default: "pending",
      },
      reviewer: ref("User"),
      reviewedAt: Date,
      note: { type: String, default: "" },
    },
    options,
  ),
);
const withdrawalSchema = new Schema(
  {
    user: ref("User", { required: true }),
    amount: money,
    institution: { type: String, required: true },
    customInstitution: { type: String, default: "" },
    accountName: { type: String, required: true },
    accountNumber: { type: String, required: true },
    status: {
      type: String,
      enum: ["pending", "paid", "rejected"],
      default: "pending",
    },
    requestKey: { type: String, required: true },
    reviewer: ref("User"),
    reviewedAt: Date,
    note: { type: String, default: "" },
  },
  options,
);
withdrawalSchema.index({ user: 1, requestKey: 1 }, { unique: true });
export const Withdrawal = model("Withdrawal", withdrawalSchema);
export const Setting = model(
  "Setting",
  new Schema(
    {
      key: { type: String, unique: true, default: "payment" },
      accountName: { type: String, default: "Muhammad Farhan" },
      accountNumber: { type: String, default: "03340490934" },
      supportEmail: { type: String, default: "" },
      supportPhone: { type: String, default: "03340490934" },
    },
    options,
  ),
);
export const models = [
  User,
  Plan,
  Purchase,
  Earning,
  Transaction,
  Deposit,
  Withdrawal,
  Setting,
];
