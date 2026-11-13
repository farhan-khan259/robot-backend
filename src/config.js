import "dotenv/config";
export const config = {
  port: Number(process.env.PORT || 4000),
  mongo: process.env.MONGODB_URI,
  secret: process.env.JWT_SECRET,
  origin: process.env.CLIENT_ORIGIN || "http://localhost:5173",
};
export function assertConfig() {
  if (!config.mongo) throw new Error("MONGODB_URI is required");
  if (!config.secret || config.secret.length < 48)
    throw new Error("JWT_SECRET must contain at least 48 random characters");
}
