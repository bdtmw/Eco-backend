import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import fs from "node:fs";

const app = express();

// Define allowed origins
export const allowedOrigins = [
  "https://ecominex.com",
  "https://mining-x-miningforuaes-projects.vercel.app",
  "http://localhost:3000",
  "http://localhost:5173",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:5173",
  "https://ecomine-mining.vercel.app",
  "https://ecominex.net",
  "https://eco-final-plum.vercel.app",
  "https://www.ecominex.net",
  "https://ecominex.vercel.app",
  "https://ecominexnett.vercel.app",
  "https://staging.ecominex.net",
  "https://eco-frontend-swart.vercel.app",
  "https://eco-frontend-i2v3.vercel.app"
].filter(Boolean);

// CORS configuration
const corsOptions = {
  origin: function (origin, callback) {
    if (!origin) {
      return callback(null, true);
    }

    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.warn("Blocked origin:", origin);
      callback(new Error("Not allowed by CORS"));
    }
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "X-Requested-With",
    "Accept",
  ],
  exposedHeaders: ["Set-Cookie"],
  maxAge: 86400,
};

// Apply CORS middleware
app.use(cors(corsOptions));

// Basic security headers
// Number of reverse proxies in front of the app (Vercel = 1; Cloudflare + cPanel = 2).
// Used for req.ip, which the rate limiter keys on.
const trustProxy = Number(process.env.TRUST_PROXY ?? 1);
app.set("trust proxy", Number.isNaN(trustProxy) ? 1 : trustProxy);
app.disable("x-powered-by");
app.use((req, res, next) => {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Strict-Transport-Security": "max-age=15552000; includeSubDomains",
  });
  next();
});

// CSRF guard: cookies are SameSite=None, so reject state-changing requests
// whose Origin is present but not one of our allowed origins.
app.use((req, res, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const origin = req.headers.origin;
  if (origin && !allowedOrigins.includes(origin)) {
    return res.status(403).json({ message: "Origin not allowed" });
  }
  next();
});

// Middleware
app.use(cookieParser());
app.use(express.json({ limit: "1mb" }));

app.get("/", (req, res) => {
  res.send("Backend is running");
});

// Dynamic route loading
const routeFiles = fs.readdirSync("./routes");

// Routes setup
for (const file of routeFiles) {
  try {
    const route = await import(`./routes/${file}`);
    app.use("/api/v1", route.default);
  } catch (err) {
    console.error(`Failed to load route file: ${file}`, err.message);
  }
}


// Central error handler: never leak stack traces or internal messages
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err?.message === "Not allowed by CORS") {
    return res.status(403).json({ message: "Origin not allowed" });
  }
  if (err?.type === "entity.parse.failed") {
    return res.status(400).json({ message: "Invalid JSON body" });
  }
  console.error("Unhandled error:", err);
  res.status(err?.status || 500).json({ message: "Server error" });
});

export default app;
