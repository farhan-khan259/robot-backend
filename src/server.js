import mongoose from "mongoose";
import cron from "node-cron";
import { config, assertConfig } from "./config.js";
import { initialize, runEarnings } from "./services.js";
import { Content, Ticket, getContent } from "./experience.js";
assertConfig();
await mongoose.connect(config.mongo);
await initialize();
await Promise.all([Content.init(), Ticket.init()]);
await getContent();
const { app } = await import("./app.js");
let busy = false;
async function tick() {
  if (busy) return;
  busy = true;
  try {
    await runEarnings();
  } catch (e) {
    console.error("Earning settlement failed:", e.message);
  } finally {
    busy = false;
  }
}
await tick();
const job = cron.schedule("* * * * *", tick);
const server = app.listen(config.port, () =>
  console.log(`RobotNetwork listening on port ${config.port}`),
);
async function shutdown() {
  job.stop();
  server.close(async () => {
    await mongoose.disconnect();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
