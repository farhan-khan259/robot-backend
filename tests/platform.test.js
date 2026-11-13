import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import supertest from "supertest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
process.env.UPLOAD_DIR = await mkdtemp(
  path.join(tmpdir(), "robotnetwork-proofs-"),
);
process.env.JWT_SECRET = "test-only-secret-".repeat(5);
const {
  User,
  Plan,
  Purchase,
  Earning,
  Transaction,
  Deposit,
  Withdrawal,
  Setting,
} = await import("../src/models.js");
const {
  initialize,
  buyPlan,
  reviewDeposit,
  requestWithdrawal,
  reviewWithdrawal,
  runEarnings,
} = await import("../src/services.js");
const { PLAN_DATA, DAY } = await import("../src/catalog.js");
const { app } = await import("../src/app.js");
let repl, request, admin, user, l1, l2, l3, token;
before(
  async () => {
    repl = await MongoMemoryReplSet.create({
      replSet: { count: 1, args: ["--nounixsocket"] },
      binary: { version: "7.0.24" },
    });
    await mongoose.connect(repl.getUri());
    await initialize();
    request = supertest(app);
    const member = async (name, parent) =>
      User.create({
        name,
        email: `${name}@example.test`,
        password: "unused",
        referralCode: name.toUpperCase(),
        referredBy: parent?._id,
      });
    admin = await member("admin");
    admin.role = "admin";
    await admin.save();
    l3 = await member("levelthree");
    l2 = await member("leveltwo", l3);
    l1 = await member("levelone", l2);
    user = await member("member", l1);
  },
  { timeout: 180000 },
);
after(async () => {
  await mongoose.disconnect();
  await repl?.stop();
  await rm(process.env.UPLOAD_DIR, { recursive: true, force: true });
});
test("exact 12-plan catalog and integer-paisa reconciliation", async () => {
  assert.equal(await Plan.countDocuments(), 12);
  assert.equal(PLAN_DATA.length, 12);
  for (const p of PLAN_DATA) {
    assert.equal(p.duration, 45);
    assert.ok(Number.isSafeInteger(p.price));
    assert.ok(Math.abs(p.total - p.daily * 45) <= 15);
  }
  const settings = await Setting.findOne();
  assert.equal(settings.accountNumber, "03340490934");
});
test("registration, login, validation, admin isolation and blocked sessions", async () => {
  let res = await request.post("/api/auth/register").send({
    name: "New Member",
    email: "new@example.test",
    password: "a-strong-password",
    referralCode: l1.referralCode,
  });
  assert.equal(res.status, 201);
  token = res.body.token;
  assert.equal(
    (await request.get("/api/me").auth(token, { type: "bearer" })).status,
    200,
  );
  assert.equal(
    (await request.get("/api/admin/users").auth(token, { type: "bearer" }))
      .status,
    403,
  );
  assert.equal((await request.get("/api/me")).status, 401);
  assert.equal(
    (
      await request
        .post("/api/auth/register")
        .send({ name: "Invalid", email: "bad@example.test", password: "short" })
    ).status,
    400,
  );
  assert.equal(
    (
      await request.post("/api/auth/register").send({
        name: "Invalid",
        email: "bad@example.test",
        password: "long-enough-password",
        referralCode: "MISSING",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request
        .post("/api/auth/login")
        .send({ email: "new@example.test", password: "wrong-password" })
    ).status,
    401,
  );
  assert.equal(
    (
      await request
        .post("/api/auth/login")
        .send({ email: "new@example.test", password: "a-strong-password" })
    ).status,
    200,
  );
  const u = await User.findOne({ email: "new@example.test" });
  u.blocked = true;
  await u.save();
  assert.equal(
    (await request.get("/api/me").auth(token, { type: "bearer" })).status,
    401,
  );
  u.blocked = false;
  await u.save();
});
test("deposit approvals credit locked funds and only 3 levels once under concurrency", async () => {
  const d = await Deposit.create({
    user: user._id,
    amount: 100000,
    tid: "TEST-APPROVAL",
    screenshot: "test",
    mime: "image/png",
  });
  const results = await Promise.allSettled([
    reviewDeposit(d._id, admin._id, "approved", "Verified"),
    reviewDeposit(d._id, admin._id, "approved", "Verified"),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal((await User.findById(user._id)).depositBalance, 100000);
  assert.equal((await User.findById(l1._id)).withdrawableBalance, 12000);
  assert.equal((await User.findById(l2._id)).withdrawableBalance, 4000);
  assert.equal((await User.findById(l3._id)).withdrawableBalance, 1000);
  assert.equal(await Transaction.countDocuments({ kind: "commission" }), 3);
  assert.equal((await User.findById(user._id)).withdrawableBalance, 0);
});
test("concurrent purchases prevent overdrafts and day 1 is immediate and idempotent", async () => {
  const p = await Plan.findOne({ code: "RN02" });
  const key = randomUUID();
  const result = await Promise.allSettled([
    buyPlan(user._id, p._id, key),
    buyPlan(user._id, p._id, key),
  ]);
  const purchases = await Purchase.find({ user: user._id });
  assert.equal(purchases.length, 1);
  assert.equal(purchases[0].creditedDays, 1);
  assert.equal((await User.findById(user._id)).depositBalance, 20000);
  assert.equal((await User.findById(user._id)).withdrawableBalance, 13333);
  assert.equal(
    String((await buyPlan(user._id, p._id, key))._id),
    String(purchases[0]._id),
  );
  await assert.rejects(buyPlan(user._id, p._id, randomUUID()), /Insufficient/);
  assert.equal(await Earning.countDocuments({ user: user._id }), 1);
});
test("24-hour boundaries, multi-worker cron, full catch-up and exact total", async () => {
  let p = await Purchase.findOne({ user: user._id });
  const start = +p.createdAt;
  await runEarnings(new Date(start + DAY - 1));
  assert.equal(await Earning.countDocuments({ purchase: p._id }), 1);
  await Promise.all([
    runEarnings(new Date(start + DAY)),
    runEarnings(new Date(start + DAY)),
  ]);
  assert.equal(await Earning.countDocuments({ purchase: p._id }), 2);
  await runEarnings(new Date(start + 100 * DAY));
  p = await Purchase.findById(p._id);
  assert.equal(p.status, "completed");
  assert.equal(p.creditedDays, 45);
  assert.equal(p.paid, 600000);
  const earnings = await Earning.find({ purchase: p._id });
  assert.equal(
    earnings.reduce((sum, e) => sum + e.amount, 0),
    600000,
  );
  assert.equal(earnings.find((e) => e.day === 45).amount, 13348);
  await runEarnings(new Date(start + 101 * DAY));
  assert.equal(await Earning.countDocuments({ purchase: p._id }), 45);
  assert.equal(await Transaction.countDocuments({ kind: "commission" }), 3);
});
test("withdrawals require active plan, reserve only earnings, refund exactly once", async () => {
  const data = {
    amount: 10000,
    institution: "easypaisa",
    accountName: "Member",
    accountNumber: "03001234567",
  };
  await assert.rejects(
    requestWithdrawal(user._id, data, randomUUID()),
    /active plan/,
  );
  await User.updateOne({ _id: user._id }, { $inc: { depositBalance: 50000 } });
  await buyPlan(
    user._id,
    (await Plan.findOne({ code: "RN01" }))._id,
    randomUUID(),
  );
  const before = await User.findById(user._id),
    key = randomUUID();
  const w = await requestWithdrawal(user._id, data, key);
  await requestWithdrawal(user._id, data, key);
  let now = await User.findById(user._id);
  assert.equal(now.withdrawableBalance, before.withdrawableBalance - 10000);
  assert.equal(now.depositBalance, before.depositBalance);
  await reviewWithdrawal(
    w._id,
    admin._id,
    "rejected",
    "Account details need correction",
  );
  await assert.rejects(
    reviewWithdrawal(w._id, admin._id, "rejected", "again"),
    /already/,
  );
  now = await User.findById(user._id);
  assert.equal(now.withdrawableBalance, before.withdrawableBalance);
  await assert.rejects(
    requestWithdrawal(
      user._id,
      { ...data, amount: now.withdrawableBalance + 1 },
      randomUUID(),
    ),
    /Insufficient/,
  );
  const paid = await requestWithdrawal(user._id, data, randomUUID());
  await reviewWithdrawal(
    paid._id,
    admin._id,
    "paid",
    "External transfer completed",
  );
  assert.equal(
    (await User.findById(user._id)).withdrawableBalance,
    before.withdrawableBalance - 10000,
  );
});
test("API rejects low withdrawals and missing idempotency keys", async () => {
  assert.equal(
    (
      await request
        .post("/api/withdrawals")
        .auth(token, { type: "bearer" })
        .set("Idempotency-Key", randomUUID())
        .send({
          amount: 99,
          institution: "easypaisa",
          accountName: "New Member",
          accountNumber: "03001234567",
        })
    ).status,
    400,
  );
  assert.equal(
    (
      await request
        .post("/api/purchases")
        .auth(token, { type: "bearer" })
        .send({ planId: String((await Plan.findOne())._id) })
    ).status,
    400,
  );
  assert.equal(
    (
      await request
        .get("/api/transactions?page=-1")
        .auth(token, { type: "bearer" })
    ).status,
    400,
  );
  assert.equal(
    (await request.get("/api/not-a-route").auth(token, { type: "bearer" }))
      .status,
    404,
  );
});
test("upload byte checks, private proof access, duplicate TID, pagination and profile", async () => {
  const tiny = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aC2kAAAAASUVORK5CYII=",
    "base64",
  );
  let res = await request
    .post("/api/deposits")
    .auth(token, { type: "bearer" })
    .field("amount", "500")
    .field("tid", "UPLOAD001")
    .attach("screenshot", tiny, {
      filename: "proof.png",
      contentType: "image/png",
    });
  assert.equal(res.status, 201);
  const deposit = res.body;
  assert.equal(
    (
      await request
        .get(`/api/deposits/${deposit._id}/proof`)
        .auth(token, { type: "bearer" })
    ).status,
    200,
  );
  const login = await request.post("/api/auth/register").send({
    name: "Other Member",
    email: "other@example.test",
    password: "a-strong-password",
  });
  assert.equal(
    (
      await request
        .get(`/api/deposits/${deposit._id}/proof`)
        .auth(login.body.token, { type: "bearer" })
    ).status,
    404,
  );
  res = await request
    .post("/api/deposits")
    .auth(token, { type: "bearer" })
    .field("amount", "500")
    .field("tid", "UPLOAD001")
    .attach("screenshot", tiny, {
      filename: "proof.png",
      contentType: "image/png",
    });
  assert.equal(res.status, 409);
  res = await request
    .post("/api/deposits")
    .auth(token, { type: "bearer" })
    .field("amount", "500")
    .field("tid", "UPLOAD002")
    .attach("screenshot", Buffer.from("not an image"), {
      filename: "proof.png",
      contentType: "image/png",
    });
  assert.equal(res.status, 400);
  for (const path of [
    "/plans",
    "/overview",
    "/purchases",
    "/earnings",
    "/transactions",
    "/team",
    "/deposits",
    "/withdrawals",
    "/institutions",
    "/public/settings",
  ])
    assert.equal(
      (await request.get("/api" + path).auth(token, { type: "bearer" })).status,
      200,
      path,
    );
  assert.equal(
    (
      await request
        .patch("/api/me")
        .auth(token, { type: "bearer" })
        .send({ name: "Updated Member", phone: "03340490934" })
    ).status,
    200,
  );
  await request.post("/api/auth/logout").auth(token, { type: "bearer" });
  assert.equal(
    (await request.get("/api/me").auth(token, { type: "bearer" })).status,
    401,
  );
});
test("administrator APIs enforce review transitions, settings and immutable plan terms", async () => {
  const jwt = (await import("jsonwebtoken")).default;
  const adminToken = jwt.sign({ ver: 0 }, process.env.JWT_SECRET, {
    subject: String(admin._id),
    expiresIn: "1h",
    issuer: "robotnetwork",
    audience: "robotnetwork-web",
  });
  for (const p of [
    "/overview",
    "/users",
    "/plans",
    "/deposits",
    "/withdrawals",
    "/settings",
  ])
    assert.equal(
      (await request.get("/api/admin" + p).auth(adminToken, { type: "bearer" }))
        .status,
      200,
      p,
    );
  let res = await request
    .patch("/api/admin/settings")
    .auth(adminToken, { type: "bearer" })
    .send({
      accountName: "Muhammad Farhan",
      accountNumber: "03340490934",
      supportEmail: "",
      supportPhone: "03340490934",
    });
  assert.equal(res.status, 200);
  const p = await Plan.findOne({ code: "RN01" });
  res = await request
    .patch(`/api/admin/plans/${p._id}`)
    .auth(adminToken, { type: "bearer" })
    .send({ enabled: false, price: 1 });
  assert.equal(res.status, 200);
  assert.equal(res.body.price, 50000);
  await assert.rejects(buyPlan(user._id, p._id, randomUUID()), /unavailable/);
  await request
    .patch(`/api/admin/plans/${p._id}`)
    .auth(adminToken, { type: "bearer" })
    .send({ enabled: true });
  const dep = await Deposit.create({
    user: user._id,
    amount: 10000,
    tid: "API-REJECT",
    screenshot: "test",
    mime: "image/png",
  });
  res = await request
    .post(`/api/admin/deposits/${dep._id}/review`)
    .auth(adminToken, { type: "bearer" })
    .send({ action: "rejected", note: "TID does not match transfer" });
  assert.equal(res.status, 200);
  res = await request
    .post(`/api/admin/deposits/${dep._id}/review`)
    .auth(adminToken, { type: "bearer" })
    .send({ action: "approved" });
  assert.equal(res.status, 409);
  assert.equal(
    (
      await request
        .patch(`/api/admin/users/${admin._id}`)
        .auth(adminToken, { type: "bearer" })
        .send({ blocked: true })
    ).status,
    400,
  );
  assert.equal(
    (
      await request
        .patch(`/api/admin/users/${l1._id}`)
        .auth(adminToken, { type: "bearer" })
        .send({ blocked: true })
    ).status,
    200,
  );
});
test("all twelve plans settle exact totals with 45 distinct earnings each", async () => {
  const batch = await User.create({
    name: "Catalog Check",
    email: "catalog@example.test",
    password: "unused",
    referralCode: "CATALOG",
    depositBalance: 100000000,
  });
  const all = await Plan.find().sort({ price: 1 });
  for (const p of all) await buyPlan(batch._id, p._id, randomUUID());
  await runEarnings(new Date(Date.now() + 46 * DAY));
  const purchases = await Purchase.find({ user: batch._id });
  assert.equal(purchases.length, 12);
  for (const p of purchases) {
    assert.equal(p.paid, p.total);
    assert.equal(p.creditedDays, 45);
    assert.equal(await Earning.countDocuments({ purchase: p._id }), 45);
  }
  assert.equal(
    (await User.findById(batch._id)).withdrawableBalance,
    all.reduce((sum, p) => sum + p.total, 0),
  );
  assert.equal(await Transaction.countDocuments({ kind: "commission" }), 3);
});
test("new member views, filtering, notifications and content use real records", async () => {
  const jwt = (await import("jsonwebtoken")).default;
  const adminToken = jwt.sign({ ver: 0 }, process.env.JWT_SECRET, {
    subject: String(admin._id),
    expiresIn: "1h",
    issuer: "robotnetwork",
    audience: "robotnetwork-web",
  });
  const registered = await request
    .post("/api/auth/register")
    .send({
      name: "Experience Member",
      email: "experience@example.test",
      password: "experience-password",
    });
  assert.equal(registered.status, 201);
  const memberToken = registered.body.token;
  const auth = (req) => req.auth(memberToken, { type: "bearer" }),
    root = (req) => req.auth(adminToken, { type: "bearer" });
  const member = await User.findOne({ email: "experience@example.test" });
  const pending = await Deposit.create({
    user: member._id,
    amount: 50000,
    tid: "EXPERIENCE-TID",
    screenshot: "test",
    mime: "image/png",
  });
  let response = await auth(request.get("/api/deposits?status=pending"));
  assert.equal(response.status, 200);
  assert.equal(response.body.total, 1);
  response = await auth(request.get("/api/deposits?status=approved"));
  assert.equal(response.body.total, 0);
  assert.equal(
    (await auth(request.get("/api/deposits?status=invalid"))).status,
    400,
  );
  assert.equal(
    (await auth(request.get("/api/withdrawals?status=invalid"))).status,
    400,
  );
  response = await auth(request.get("/api/notifications"));
  assert.equal(response.status, 200);
  assert.equal(response.body.unread, 1);
  await auth(request.post("/api/notifications/read"));
  response = await auth(request.get("/api/notifications"));
  assert.equal(response.body.unread, 0);
  await reviewDeposit(pending._id, admin._id, "approved", "Transfer verified");
  response = await auth(request.get("/api/notifications"));
  assert.equal(response.body.unread, 1);
  assert.match(response.body.items[0].title, /approved/);
  response = await auth(request.get("/api/me/summary"));
  assert.equal(response.status, 200);
  assert.equal(
    response.body.deposits.find((x) => x._id === "approved").amount,
    50000,
  );
  response = await auth(request.get("/api/transactions?kind=deposit"));
  assert.equal(response.body.total, 1);
  assert.equal(response.body.items[0].amount, 50000);
  const other = String(l2._id);
  response = await auth(request.get("/api/transactions?user=" + other));
  assert.equal(response.body.total, 1);
  assert.equal(response.body.items[0].user, String(member._id));
  assert.equal(
    (await auth(request.get("/api/transactions?kind=invalid"))).status,
    400,
  );
  assert.equal(
    (await root(request.get("/api/admin/transactions?from=bad"))).status,
    400,
  );
  assert.equal(
    (
      await root(
        request.get("/api/admin/transactions?from=2026-11-14&to=2026-11-13"),
      )
    ).status,
    400,
  );
  assert.equal((await root(request.get("/api/admin/transactions?from=2026-02-31"))).status,400);
  assert.equal((await root(request.patch("/api/admin/content").send({heroTitle:"A heading",heroSubtitle:"An introduction",announcementEnabled:false,announcementTitle:"",announcementBody:"",announcementLink:"/\n/evil.example",faqs:[{category:"Plans",question:"A question",answer:"An answer"}]}))).status,400);
  const plan = await Plan.findOne({ code: "RN01" });
  response = await auth(request.get(`/api/plans/${plan._id}`));
  assert.equal(response.status, 200);
  assert.equal(response.body.price, 50000);
  const original = plan.toObject();
  response = await root(
    request
      .patch(`/api/admin/plans/${plan._id}`)
      .send({
        name: "Robot 01 — Edition",
        description: "A new description",
        price: 1,
        daily: 1,
        total: 1,
        duration: 1,
      }),
  );
  assert.equal(response.status, 200);
  for (const key of ["price", "daily", "total", "duration"])
    assert.equal(response.body[key], original[key]);
  response = await request.get("/api/public/content");
  assert.equal(response.status, 200);
  const content = response.body;
  assert.ok(content.faqs.length >= 1);
  const changed = {
    ...content,
    heroTitle: "A considered new beginning",
    announcementEnabled: true,
    announcementTitle: "Member update",
    announcementBody: "An update from the team.",
    announcementLink: "/plans",
  };
  response = await root(request.patch("/api/admin/content").send(changed));
  assert.equal(response.status, 200);
  response = await request.get("/api/public/content");
  assert.equal(response.body.heroTitle, changed.heroTitle);
  assert.equal(response.body.announcementEnabled, true);
  assert.equal(
    (await auth(request.patch("/api/admin/content").send(changed))).status,
    403,
  );
  assert.equal(
    (
      await root(
        request
          .patch("/api/admin/content")
          .send({ ...changed, announcementLink: "https://example.com" }),
      )
    ).status,
    400,
  );
  response = await root(
    request.get("/api/admin/users?q=" + encodeURIComponent("Experience")),
  );
  assert.equal(response.body.total, 1);
  response = await root(
    request.get("/api/admin/users?q=" + encodeURIComponent(".*")),
  );
  assert.equal(response.body.total, 0);
  for (const p of [
    "/api/admin/transactions",
    "/api/admin/commissions",
    "/api/admin/reports",
    `/api/admin/users/${member._id}/detail`,
  ])
    assert.equal((await root(request.get(p))).status, 200, p);
  response = await root(
    request.get("/api/admin/transactions/export?kind=deposit"),
  );
  assert.equal(response.status, 200);
  assert.match(response.headers["content-type"], /text\/csv/);
  assert.match(response.text, /Amount PKR/);
  assert.match(response.text, /Transfer verified|Easypaisa deposit approved/);
  assert.equal(
    (await auth(request.get("/api/admin/transactions/export"))).status,
    403,
  );
});
test("support conversations persist, enforce ownership and honor administrator status changes", async () => {
  const jwt = (await import("jsonwebtoken")).default;
  const adminToken = jwt.sign({ ver: 0 }, process.env.JWT_SECRET, {
    subject: String(admin._id),
    expiresIn: "1h",
    issuer: "robotnetwork",
    audience: "robotnetwork-web",
  });
  const member = await request
      .post("/api/auth/login")
      .send({
        email: "experience@example.test",
        password: "experience-password",
      }),
    other = await request
      .post("/api/auth/login")
      .send({ email: "other@example.test", password: "a-strong-password" });
  const auth = (req) => req.auth(member.body.token, { type: "bearer" }),
    root = (req) => req.auth(adminToken, { type: "bearer" }),
    stranger = (req) => req.auth(other.body.token, { type: "bearer" });
  let response = await auth(
    request
      .post("/api/tickets")
      .send({
        subject: "Payment question",
        category: "deposit",
        message: "Please review my payment receipt.",
      }),
  );
  assert.equal(response.status, 201);
  const ticket = response.body;
  response = await auth(request.get("/api/tickets"));
  assert.equal(response.body.total, 1);
  assert.equal(
    (await stranger(request.get(`/api/tickets/${ticket._id}`))).status,
    404,
  );
  response = await auth(
    request
      .post(`/api/tickets/${ticket._id}/replies`)
      .send({ message: "Here is some more context." }),
  );
  assert.equal(response.status, 200);
  assert.equal(response.body.messages.length, 2);
  response = await root(
    request
      .post(`/api/admin/tickets/${ticket._id}/replies`)
      .send({ message: "We have reviewed your request." }),
  );
  assert.equal(response.status, 200);
  assert.equal(response.body.messages.at(-1).role, "admin");
  response = await auth(request.get(`/api/tickets/${ticket._id}`));
  assert.equal(
    response.body.messages.at(-1).body,
    "We have reviewed your request.",
  );
  response = await root(
    request
      .patch(`/api/admin/tickets/${ticket._id}`)
      .send({ status: "closed" }),
  );
  assert.equal(response.status, 200);
  assert.equal(
    (
      await auth(
        request
          .post(`/api/tickets/${ticket._id}/replies`)
          .send({ message: "another message" }),
      )
    ).status,
    409,
  );
  await root(
    request.patch(`/api/admin/tickets/${ticket._id}`).send({ status: "open" }),
  );
  assert.equal(
    (
      await auth(
        request
          .post(`/api/tickets/${ticket._id}/replies`)
          .send({ message: "Thank you." }),
      )
    ).status,
    200,
  );
  response = await root(request.get("/api/admin/tickets?status=open"));
  assert.equal(response.body.total, 1);
  assert.equal(
    (
      await auth(
        request
          .post("/api/tickets")
          .send({ subject: "x", category: "wrong", message: "x" }),
      )
    ).status,
    400,
  );
});
