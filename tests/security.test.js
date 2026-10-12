// Tests that never touch the database: they exercise auth gates, input
// validation, CSRF origin check, rate limiting and the cron secret check.
import request from "supertest";

let app;
let ip = 0;
const nextIp = () => `10.0.0.${++ip}`; // rate limiter keys on req.ip (trust proxy = 1)

beforeAll(async () => {
  process.env.JWT_SECRET = "test-jwt-secret";
  process.env.CRON_SECRET = "test-cron-secret";
  app = (await import("../app.js")).default;
});

const API = "/api/v1";

describe("routes that used to be open now require login", () => {
  const cases = [
    ["post", "/mining-machines"],
    ["put", "/mining-machines/abc"],
    ["delete", "/mining-machines/abc"],
    ["patch", "/settings/2fa"],
    ["post", "/change-password"],
    ["get", "/referrals/abc"],
    ["post", "/update-profits"],
    ["post", "/purchaseMAchine"],
    ["post", "/purchase"],
    ["post", "/sell-machine/abc"],
    ["post", "/sell/abc"],
    ["get", "/balance/abc"],
    ["get", "/sales-history/abc"],
    ["get", "/userMachine/abc"],
    ["get", "/user-shares/abc"],
    ["get", "/profit/percentages/abc"],
    ["patch", "/profit/abc"],
    ["get", "/withdrawals/by-email"],
    ["get", "/balanceUpade/history"],
    ["post", "/withdrawals/create"],
    ["post", "/withdrawals/request"],
    ["post", "/deposit"],
  ];

  test.each(cases)("%s %s -> 401 without a token", async (method, path) => {
    const res = await request(app)[method](API + path).set("X-Forwarded-For", nextIp());
    expect(res.status).toBe(401);
  });

  test("garbage bearer token -> 401", async () => {
    const res = await request(app)
      .get(API + "/balance/abc")
      .set("Authorization", "Bearer not-a-jwt");
    expect(res.status).toBe(401);
  });
});

describe("removed debug route", () => {
  test("GET /debug-shares -> 404", async () => {
    const res = await request(app).get("/debug-shares");
    expect(res.status).toBe(404);
  });
});

describe("input validation happens before any lookup", () => {
  test("forget-password rejects an operator object (NoSQL injection)", async () => {
    const res = await request(app)
      .post(API + "/forget-password")
      .set("X-Forwarded-For", nextIp())
      .send({ email: { $ne: null } });
    expect(res.status).toBe(400);
    expect(res.body.resetToken).toBeUndefined();
  });

  test("login rejects non-string credentials", async () => {
    const res = await request(app)
      .post(API + "/login")
      .set("X-Forwarded-For", nextIp())
      .send({ email: { $gt: "" }, password: { $gt: "" } });
    expect(res.status).toBe(400);
  });

  test("verify-otp rejects non-string otp", async () => {
    const res = await request(app)
      .post(API + "/verify-otp")
      .set("X-Forwarded-For", nextIp())
      .send({ email: "a@test.com", otp: { $ne: null } });
    expect(res.status).toBe(400);
  });
});

describe("cron endpoint", () => {
  test("no secret -> 401", async () => {
    const res = await request(app).get(API + "/cron/profit-update");
    expect(res.status).toBe(401);
  });

  test("wrong secret -> 401", async () => {
    const res = await request(app)
      .get(API + "/cron/profit-update")
      .set("x-cron-secret", "nope");
    expect(res.status).toBe(401);
  });

  test("secret in the query string is no longer accepted", async () => {
    const res = await request(app).get(API + "/cron/profit-update?secret=test-cron-secret");
    expect(res.status).toBe(401);
  });

  test("fails closed when CRON_SECRET is not configured", async () => {
    const saved = process.env.CRON_SECRET;
    delete process.env.CRON_SECRET;
    try {
      const res = await request(app).get(API + "/cron/profit-update");
      expect(res.status).toBe(401);
    } finally {
      process.env.CRON_SECRET = saved;
    }
  });
});

describe("CSRF origin guard", () => {
  test("state-changing request from a foreign origin -> 403", async () => {
    const res = await request(app)
      .post(API + "/login")
      .set("Origin", "https://evil.example")
      .set("X-Forwarded-For", nextIp())
      .send({});
    expect(res.status).toBe(403);
  });

  test("request from an allowed origin passes the guard", async () => {
    const res = await request(app)
      .post(API + "/login")
      .set("Origin", "https://ecominex.net")
      .set("X-Forwarded-For", nextIp())
      .send({});
    expect(res.status).toBe(400); // reaches the controller (missing fields)
  });

  test("form-encoded bodies are not parsed", async () => {
    const res = await request(app)
      .post(API + "/login")
      .set("X-Forwarded-For", nextIp())
      .type("form")
      .send({ email: "a@test.com", password: "secret1" });
    expect(res.status).toBe(400); // body ignored -> "All fields are required"
  });
});

describe("rate limiting", () => {
  test("OTP endpoint returns 429 after repeated attempts from one IP", async () => {
    const attacker = nextIp();
    const codes = [];
    for (let i = 0; i < 10; i++) {
      const res = await request(app)
        .post(API + "/verify-otp")
        .set("X-Forwarded-For", attacker)
        .send({ email: "a@test.com", otp: { bad: true } });
      codes.push(res.status);
    }
    expect(codes.slice(0, 8).every((c) => c === 400)).toBe(true);
    expect(codes.slice(8)).toEqual([429, 429]);
  });

  test("a different IP is not affected", async () => {
    const res = await request(app)
      .post(API + "/verify-otp")
      .set("X-Forwarded-For", nextIp())
      .send({ email: "a@test.com", otp: { bad: true } });
    expect(res.status).toBe(400);
  });
});

describe("security headers", () => {
  test("sets hardening headers and hides x-powered-by", async () => {
    const res = await request(app).get("/");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });
});
