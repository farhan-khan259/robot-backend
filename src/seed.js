import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import { config, assertConfig } from "./config.js";
import { initialize, ensure } from "./services.js";
import { User } from "./models.js";
import { Content, Ticket, getContent } from "./experience.js";
assertConfig();
try {
  await mongoose.connect(config.mongo);
  await initialize();
  await Promise.all([Content.init(), Ticket.init()]);
  await getContent();
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase(),
    password = process.env.ADMIN_PASSWORD;
  ensure(
    email && /^[^ @]+@[^ @]+\.[^ @]+$/.test(email),
    "Set a valid ADMIN_EMAIL",
  );
  ensure(
    password && password.length >= 14,
    "Set ADMIN_PASSWORD with at least 14 characters",
  );
  const old = await User.findOne({ email });
  ensure(
    !old || old.role === "admin",
    "Email belongs to an existing member; choose a different admin email",
  );
  if (!old) {
    await User.create({
      name: process.env.ADMIN_NAME || "Administrator",
      email,
      password: await bcrypt.hash(password, 12),
      role: "admin",
      referralCode: randomBytes(6).toString("hex").toUpperCase(),
    });
    console.log("Administrator created");
  } else console.log("Administrator already exists; password unchanged");
  console.log("12 RobotNetwork plans initialized");
} finally {
  await mongoose.disconnect();
}
