import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import connect from "./config.js";
import fs from "node:fs";
import { setupAutoProfitUpdates } from "./cronJobs.js";

const app = express();

// Define allowed origins
const allowedOrigins = [
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
app.set("trust proxy", 1);
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
const port = process.env.PORT || 8000;
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

const server = async () => {
  try {
    await connect();
    setupAutoProfitUpdates();
    app.listen(port, () => {
      console.log(`Server is running on port ${port}`);
      console.log("Allowed origins:", allowedOrigins);
    });
  } catch (error) {
    console.error("Failed to start server:", error.message);
    process.exit(1);
  }
};
server();
