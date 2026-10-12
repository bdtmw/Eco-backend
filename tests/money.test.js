// Database-backed tests for the fixes to auth, ownership and money handling.
// Requires a MongoDB replica set (see tests/helpers/db.js).
import { jest } from "@jest/globals";
import request from "supertest";
import mongoose from "mongoose";
import { connectTestDb, disconnectTestDb, clearDb } from "./helpers/db.js";

const sentEmails = [];
jest.unstable_mockModule("../helper/emailServer.js", () => ({
  sendEmail: jest.fn(async (to, subject, message) => {
    sentEmails.push({ to, subject, message });
  }),
}));

process.env.JWT_SECRET = "test-jwt-secret";
process.env.CRON_SECRET = "test-cron-secret";

const API = "/api/v1";
let app, User, Balance, MiningMachine, UserMachine, SharePurchase, Transaction, Withdrawal, generateToken;
let ip = 0;
const nextIp = () => `10.1.${Math.floor(ip / 250)}.${(ip++ % 250) + 1}`;

const api = (method, path, token) => {
  const r = request(app)[method](API + path).set("X-Forwarded-For", nextIp());
  return token ? r.set("Authorization", `Bearer ${token}`) : r;
};

beforeAll(async () => {
  await connectTestDb();
  app = (await import("../app.js")).default;
  User = (await import("../model/UserModel.js")).default;
  Balance = (await import("../model/Balance.js")).default;
  MiningMachine = (await import("../model/MiningMachine.js")).default;
  UserMachine = (await import("../model/UserMAchine.js")).default;
  SharePurchase = (await import("../model/SharePurchase.js")).default;
  Transaction = (await import("../model/withdrawals.js")).default;
  Withdrawal = (await import("../model/withdrawalModel.js")).default;
  generateToken = (await import("../helper/generateToken.js")).default;
  await Promise.all([User, Balance, MiningMachine, UserMachine, SharePurchase, Transaction, Withdrawal].map((m) => m.init()));
});

afterAll(async () => {
  await disconnectTestDb();
});

beforeEach(async () => {
  sentEmails.length = 0;
  await clearDb();
});

let counter = 0;
async function makeUser({ role = "user", mainBalance = 0, adminAdd = 0, miningBalance = 0, password = "password1" } = {}) {
  counter += 1;
  const user = await User.create({
    firstName: "Test",
    lastName: `User${counter}`,
    email: `user${counter}@test.com`,
    password,
    country: "US",
    phoneNumber: "1234567890",
    role,
    isVerified: true,
    mainBalance,
  });
  await Balance.create({ user: user._id, adminAdd, miningBalance, totalBalance: adminAdd + miningBalance });
  return { user, token: generateToken(user._id), id: String(user._id) };
}

const makeMachine = (over = {}) =>
  MiningMachine.create({
    machineName: "Test Miner",
    hashrate: "100 TH/s",
    powerConsumption: 3000,
    priceRange: 1000,
    coinsMined: "Bitcoin",
    monthlyProfit: 100,
    description: "test",
    ...over,
  });

const assignMachine = (userId, machine, over = {}) =>
  UserMachine.create({
    user: userId,
    machine: machine._id,
    machineName: machine.machineName,
    hashrate: machine.hashrate,
    powerConsumption: machine.powerConsumption,
    priceRange: machine.priceRange,
    coinsMined: machine.coinsMined,
    monthlyProfit: machine.monthlyProfit,
    description: machine.description,
    ...over,
  });

const balanceOf = (userId) => Balance.findOne({ user: userId }).lean();

describe("password reset and login", () => {
  test("forgot-password never returns the token, stores only a hash, and the emailed token works once", async () => {
    const { user } = await makeUser();

    const res = await api("post", "/forget-password").send({ email: user.email });
    expect(res.status).toBe(200);
    expect(res.body.resetToken).toBeUndefined();

    const mail = sentEmails.find((m) => m.subject === "Password Reset");
    const token = mail.message.match(/reset-password\/([a-f0-9]{64})/)[1];

    const stored = await User.findById(user._id);
    expect(stored.resetPasswordToken).toMatch(/^[a-f0-9]{64}$/);
    expect(stored.resetPasswordToken).not.toBe(token); // hashed, not raw

    const reset = await api("post", `/reset-password/${token}`).send({ password: "newpass12" });
    expect(reset.status).toBe(200);

    const reuse = await api("post", `/reset-password/${token}`).send({ password: "another12" });
    expect(reuse.status).toBe(400);

    expect((await api("post", "/login").send({ email: user.email, password: "password1" })).status).toBe(400);
    expect((await api("post", "/login").send({ email: user.email, password: "newpass12" })).status).toBe(200);
  });

  test("the stored hash itself cannot be used as a reset token", async () => {
    const { user } = await makeUser();
    await api("post", "/forget-password").send({ email: user.email });
    const { resetPasswordToken } = await User.findById(user._id);
    const res = await api("post", `/reset-password/${resetPasswordToken}`).send({ password: "newpass12" });
    expect(res.status).toBe(400);
  });

  test("forgot-password gives the same answer for unknown emails", async () => {
    const res = await api("post", "/forget-password").send({ email: "nobody@test.com" });
    expect(res.status).toBe(200);
    expect(sentEmails).toHaveLength(0);
  });

  test("login does not reveal whether the account exists", async () => {
    const { user } = await makeUser();
    const wrongPw = await api("post", "/login").send({ email: user.email, password: "wrongpass" });
    const noUser = await api("post", "/login").send({ email: "ghost@test.com", password: "wrongpass" });
    expect(wrongPw.status).toBe(noUser.status);
    expect(wrongPw.body.message).toBe(noUser.body.message);
  });

  test("register lowercases the email so duplicates cannot differ by case", async () => {
    const body = { firstName: "A", lastName: "B", email: "Mixed@Test.com", password: "password1", country: "US", phoneNumber: "1234567890" };
    expect((await api("post", "/register").send(body)).status).toBe(200);
    expect((await api("post", "/register").send({ ...body, email: "mixed@test.com" })).status).toBe(400);
    expect(await User.findOne({ email: "mixed@test.com" })).not.toBeNull();
  });

  test("2FA toggle only changes the caller, ignoring a userId in the body", async () => {
    const a = await makeUser();
    const b = await makeUser();
    await User.updateOne({ _id: a.user._id }, { twoFactorEnabled: true });

    const res = await api("patch", "/settings/2fa", b.token).send({ userId: a.id, enabled: false });
    expect(res.status).toBe(200);
    expect((await User.findById(a.id)).twoFactorEnabled).toBe(true);
  });

  test("change-password requires the caller's current password", async () => {
    const a = await makeUser();
    const b = await makeUser();
    const bad = await api("post", "/change-password", a.token).send({ userId: b.id, currentPassword: "nope", newPassword: "newpass12" });
    expect(bad.status).toBe(400);
    const ok = await api("post", "/change-password", a.token).send({ userId: b.id, currentPassword: "password1", newPassword: "newpass12" });
    expect(ok.status).toBe(200);
    const login = (u, p) => api("post", "/login").send({ email: u.user.email, password: p });
    expect((await login(a, "newpass12")).status).toBe(200); // A changed
    expect((await login(b, "password1")).status).toBe(200); // B untouched
  });
});

describe("authorization and data exposure", () => {
  test("normal users cannot use admin routes; admin user list hides secrets", async () => {
    const user = await makeUser();
    const admin = await makeUser({ role: "admin" });
    await User.updateOne({ _id: user.user._id }, { otpCode: "123456", resetPasswordToken: "abc" });

    expect((await api("post", "/mining-machines", user.token)).status).toBe(403);
    expect((await api("get", "/admin/users", user.token)).status).toBe(403);

    const res = await api("get", "/admin/users", admin.token);
    expect(res.status).toBe(200);
    const json = JSON.stringify(res.body);
    expect(json).not.toMatch(/"password"/);
    expect(json).not.toMatch(/otpCode|resetPasswordToken/);
  });

  test("balance, history and machine data are limited to the owner (admin may read any)", async () => {
    const a = await makeUser({ adminAdd: 100 });
    const b = await makeUser({ adminAdd: 500 });
    const admin = await makeUser({ role: "admin" });

    expect((await api("get", `/balance/${b.id}`, a.token)).status).toBe(403);
    expect((await api("get", `/balance/${a.id}`, a.token)).status).toBe(200);
    expect((await api("get", `/balance/${b.id}`, admin.token)).status).toBe(200);
    expect((await api("get", `/sales-history/${b.id}`, a.token)).status).toBe(403);
    expect((await api("get", `/user-shares/${b.id}`, a.token)).status).toBe(403);
    expect((await api("get", `/profit/percentages/${b.id}`, a.token)).status).toBe(403);
    expect((await api("get", `/userMachine/${b.id}`, a.token)).status).toBe(404);
    expect((await api("get", `/referrals/${b.id}`, a.token)).status).toBe(403);
  });

  test("transaction history only returns the caller's own rows", async () => {
    const a = await makeUser();
    const b = await makeUser();
    await Transaction.create({ user: a.user._id, amount: 1, type: "ADMIN_ADD", status: "approved" });
    await Transaction.create({ user: b.user._id, amount: 2, type: "ADMIN_ADD", status: "approved", walletAddress: "SECRET-WALLET" });

    const res = await api("get", "/balanceUpade/history", a.token);
    expect(res.status).toBe(200);
    expect(res.body.transactions).toHaveLength(1);
    expect(JSON.stringify(res.body)).not.toMatch(/SECRET-WALLET/);

    const byEmail = await api("get", `/withdrawals/by-email?email=${b.user.email}`, a.token);
    expect(byEmail.status).toBe(200);
    expect(JSON.stringify(byEmail.body)).not.toMatch(/SECRET-WALLET/); // still returns A's own data
  });

  test("admin balance top-up rejects string, negative and unknown-user input", async () => {
    const admin = await makeUser({ role: "admin" });
    const a = await makeUser();
    expect((await api("post", "/balance/update", admin.token).send({ userId: a.id, amount: "100" })).status).toBe(400);
    expect((await api("post", "/balance/update", admin.token).send({ userId: a.id, amount: -5 })).status).toBe(400);
    expect((await api("post", "/balance/update", admin.token).send({ userId: new mongoose.Types.ObjectId(), amount: 5 })).status).toBe(404);
    expect((await api("post", "/balance/update", admin.token).send({ userId: a.id, amount: 100 })).status).toBe(200);
    expect((await balanceOf(a.user._id)).adminAdd).toBe(100);
  });
});

describe("withdrawals", () => {
  const wallet = { walletNumber: "TXYZ", walletType: "USDT", walletName: "me" };

  test("negative, zero, string and oversized amounts are rejected and the balance is unchanged", async () => {
    const a = await makeUser({ mainBalance: 100 });
    for (const amount of [-100, 0, "50", 101, null]) {
      const res = await api("post", "/withdrawals/create", a.token).send({ amount, ...wallet });
      expect(res.status).toBe(400);
    }
    expect((await User.findById(a.id)).mainBalance).toBe(100);
    expect(await Withdrawal.countDocuments()).toBe(0);
  });

  test("parallel requests cannot double-spend the balance", async () => {
    const a = await makeUser({ mainBalance: 100 });
    const results = await Promise.all(
      Array.from({ length: 6 }, () => api("post", "/withdrawals/create", a.token).send({ amount: 100, ...wallet }))
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect((await User.findById(a.id)).mainBalance).toBe(0);
    expect(await Withdrawal.countDocuments()).toBe(1);
  });

  test("a request can only be processed once, so a refund happens once", async () => {
    const a = await makeUser({ mainBalance: 100 });
    const admin = await makeUser({ role: "admin" });
    const created = await api("post", "/withdrawals/create", a.token).send({ amount: 60, ...wallet });
    const id = created.body.withdrawal._id;
    expect((await User.findById(a.id)).mainBalance).toBe(40);

    expect((await api("patch", `/withdrawal/${id}`, admin.token).send({ status: "Rejected" })).status).toBe(200);
    expect((await api("patch", `/withdrawal/${id}`, admin.token).send({ status: "Rejected" })).status).toBe(409);
    expect((await api("patch", `/withdrawal/${id}`, admin.token).send({ status: "Approved" })).status).toBe(409);
    expect((await User.findById(a.id)).mainBalance).toBe(100); // refunded exactly once
  });

  test("normal users cannot approve or reject", async () => {
    const a = await makeUser({ mainBalance: 100 });
    const created = await api("post", "/withdrawals/create", a.token).send({ amount: 10, ...wallet });
    const res = await api("patch", `/withdrawal/${created.body.withdrawal._id}`, a.token).send({ status: "Approved" });
    expect(res.status).toBe(403);
  });

  test("/withdrawals/request uses the caller, and pending requests reduce what is available", async () => {
    const a = await makeUser({ adminAdd: 100 });
    const b = await makeUser({ adminAdd: 100 });
    const body = { amount: 80, walletAddress: "TXYZ", network: "TRC20" };

    const first = await api("post", "/withdrawals/request", a.token).send({ ...body, userId: b.id, email: b.user.email });
    expect(first.status).toBe(200);
    expect(await Transaction.countDocuments({ user: b.user._id, type: "withdrawal" })).toBe(0);
    expect(await Transaction.countDocuments({ user: a.user._id, type: "withdrawal" })).toBe(1);

    const second = await api("post", "/withdrawals/request", a.token).send(body);
    expect(second.status).toBe(400); // only 20 left after the pending 80

    expect((await api("post", "/withdrawals/request", a.token).send({ ...body, amount: -5 })).status).toBe(400);
    expect((await api("post", "/withdrawals/request", a.token).send({ ...body, amount: "5" })).status).toBe(400);
  });

  test("admin approval deducts balances and cannot be repeated", async () => {
    const a = await makeUser({ adminAdd: 100 });
    const admin = await makeUser({ role: "admin" });
    const req = await api("post", "/withdrawals/request", a.token).send({ amount: 30, walletAddress: "TXYZ", network: "TRC20" });
    const transactionId = req.body.transaction._id;

    const ok = await api("post", "/withdrawals/process", admin.token).send({ transactionId, action: "approved" });
    expect(ok.status).toBe(200);
    expect((await balanceOf(a.user._id)).totalBalance).toBe(70);

    const again = await api("post", "/withdrawals/process", admin.token).send({ transactionId, action: "approved" });
    expect(again.status).toBe(400);
    expect((await balanceOf(a.user._id)).totalBalance).toBe(70);
  });
});

describe("machine purchase and sale", () => {
  test("purchase always charges the caller, never a userId from the body", async () => {
    const a = await makeUser({ adminAdd: 2500 });
    const b = await makeUser({ adminAdd: 2500 });
    const machine = await makeMachine();

    const res = await api("post", "/purchaseMAchine", a.token).send({ userId: b.id, machineId: String(machine._id), quantity: 2 });
    expect(res.status).toBe(201);
    expect((await balanceOf(a.user._id)).adminAdd).toBe(500);
    expect((await balanceOf(b.user._id)).adminAdd).toBe(2500);
    expect(await UserMachine.countDocuments({ user: a.user._id })).toBe(2);
    expect(await UserMachine.countDocuments({ user: b.user._id })).toBe(0);
  });

  test("invalid quantities and insufficient funds are rejected without side effects", async () => {
    const a = await makeUser({ adminAdd: 1500, miningBalance: 5000 }); // mining profit must not pay for purchases
    const machine = await makeMachine();
    for (const quantity of [1.5, "2", 0, -1, 101]) {
      expect((await api("post", "/purchaseMAchine", a.token).send({ machineId: String(machine._id), quantity })).status).toBe(400);
    }
    const tooMany = await api("post", "/purchaseMAchine", a.token).send({ machineId: String(machine._id), quantity: 2 });
    expect(tooMany.status).toBe(400);
    expect(await UserMachine.countDocuments()).toBe(0);
    expect((await balanceOf(a.user._id)).adminAdd).toBe(1500);
  });

  test("referral bonus is credited to the referrer's spendable balance and survives recalculation", async () => {
    const referrer = await makeUser();
    const buyer = await makeUser({ adminAdd: 1000 });
    await User.updateOne({ _id: buyer.user._id }, { referralId: referrer.user._id });
    const machine = await makeMachine();

    await api("post", "/purchaseMAchine", buyer.token).send({ machineId: String(machine._id), quantity: 1 });
    const bal = await balanceOf(referrer.user._id);
    expect(bal.adminAdd).toBe(100); // 10% of the first purchase
    expect(bal.totalBalance).toBe(bal.adminAdd + bal.miningBalance);
  });

  test("a user cannot sell someone else's machine; the owner can, at 90% of the recorded price", async () => {
    const owner = await makeUser();
    const attacker = await makeUser();
    const machine = await makeMachine({ priceRange: 1000 });
    const um = await assignMachine(owner.user._id, machine, { priceRange: 800 }); // price at assignment

    const stolen = await api("post", `/sell-machine/${um._id}`, attacker.token);
    expect(stolen.status).toBe(404);
    expect((await UserMachine.findById(um._id)).status).toBe("active");
    expect((await balanceOf(owner.user._id)).adminAdd).toBe(0);

    const ok = await api("post", `/sell-machine/${um._id}`, owner.token);
    expect(ok.status).toBe(200);
    expect((await balanceOf(owner.user._id)).adminAdd).toBe(720);
    expect((await api("post", `/sell-machine/${um._id}`, owner.token)).status).toBe(400); // no double sale
  });
});

describe("share machine", () => {
  const makeShareMachine = () =>
    makeMachine({ isShareBased: true, priceRange: 19000, sharePrice: 50, totalShares: 380, profitPerShare: 9.21, monthlyProfit: 3500 });

  test("purchases are capped by total shares held, not by number of purchase records", async () => {
    await makeShareMachine();
    const a = await makeUser({ adminAdd: 100000 });
    const b = await makeUser({ adminAdd: 100000 });

    expect((await api("post", "/purchase", a.token).send({ numberOfShares: 300 })).status).toBe(201);
    const over = await api("post", "/purchase", b.token).send({ numberOfShares: 81 });
    expect(over.status).toBe(400);
    expect((await api("post", "/purchase", b.token).send({ numberOfShares: 80 })).status).toBe(201);
    expect((await api("post", "/purchase", b.token).send({ numberOfShares: 1 })).status).toBe(400); // sold out

    const pub = await api("get", "/special-machine");
    expect(pub.body.data.soldShares).toBe(380);
    expect(pub.body.data.availableShares).toBe(0);
  });

  test("share purchase ignores a body userId, rejects bad counts, and uses deposited funds only", async () => {
    await makeShareMachine();
    const a = await makeUser({ adminAdd: 100, miningBalance: 10000 });
    const b = await makeUser({ adminAdd: 10000 });

    for (const numberOfShares of [0, -1, 1.5, "2"]) {
      expect((await api("post", "/purchase", a.token).send({ numberOfShares })).status).toBe(400);
    }
    expect((await api("post", "/purchase", a.token).send({ numberOfShares: 3 })).status).toBe(400); // 150 > 100 deposited
    expect((await api("post", "/purchase", a.token).send({ userId: b.id, numberOfShares: 2 })).status).toBe(201);
    expect((await balanceOf(b.user._id)).adminAdd).toBe(10000);
    expect((await balanceOf(a.user._id)).adminAdd).toBe(0);
  });

  test("only the owner can sell or view shares", async () => {
    const machine = await makeShareMachine();
    const owner = await makeUser();
    const other = await makeUser();
    const share = await SharePurchase.create({
      user: owner.user._id, machine: machine._id, numberOfShares: 10, pricePerShare: 50, profitPerShare: 9.21, totalInvestment: 500,
    });

    expect((await api("post", `/sell/${share._id}`, other.token).send({ numberOfSharesToSell: 10 })).status).toBe(404);
    expect((await api("get", `/user-shares/${owner.id}`, other.token)).status).toBe(403);

    const ok = await api("post", `/sell/${share._id}`, owner.token).send({ numberOfSharesToSell: 4 });
    expect(ok.status).toBe(200);
    expect((await balanceOf(owner.user._id)).adminAdd).toBe(180); // 4 * 50 * 0.9
    expect((await SharePurchase.findById(share._id)).numberOfShares).toBe(6);
  });
});

describe("profit job", () => {
  const run = () => request(app).get(API + "/cron/profit-update").set("x-cron-secret", "test-cron-secret");
  const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

  test("pays whole 30-day periods once, even when two runs overlap", async () => {
    const a = await makeUser();
    const machine = await makeMachine({ monthlyProfit: 100 });
    const um = await assignMachine(a.user._id, machine, { assignedDate: daysAgo(65) }); // 2 full months due

    const [r1, r2] = await Promise.all([run(), run()]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);

    expect((await balanceOf(a.user._id)).miningBalance).toBe(200);
    expect(await Transaction.countDocuments({ user: a.user._id, type: "profit" })).toBe(1);

    const third = await run();
    expect(third.status).toBe(200);
    expect((await balanceOf(a.user._id)).miningBalance).toBe(200); // nothing more due
    const saved = await UserMachine.findById(um._id);
    expect(saved.lastProfitUpdate.getTime()).toBeCloseTo(daysAgo(65).getTime() + 60 * 86400000, -4);
  });

  test("share profits are also paid once", async () => {
    const machine = await makeMachine({ isShareBased: true, priceRange: 19000, sharePrice: 50, totalShares: 380, profitPerShare: 10 });
    const a = await makeUser();
    await SharePurchase.create({
      user: a.user._id, machine: machine._id, numberOfShares: 5, pricePerShare: 50, profitPerShare: 10,
      totalInvestment: 250, purchaseDate: daysAgo(31), lastProfitUpdate: daysAgo(31),
    });
    await Promise.all([run(), run()]);
    expect((await balanceOf(a.user._id)).miningBalance).toBe(50);
  });

  test("a user cannot trigger payouts early through the manual endpoint", async () => {
    const a = await makeUser();
    const machine = await makeMachine();
    const um = await assignMachine(a.user._id, machine, { assignedDate: daysAgo(5) });
    const res = await api("patch", `/profit/${um._id}`, a.token);
    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/too soon/i);
    expect((await balanceOf(a.user._id)).miningBalance).toBe(0);

    const other = await makeUser();
    expect((await api("patch", `/profit/${um._id}`, other.token)).status).toBe(404);
  });
});

describe("deposits", () => {
  test("manual deposit is recorded for the caller with a validated amount", async () => {
    const a = await makeUser();
    const b = await makeUser();
    const Deposit = (await import("../model/depositeModel.js")).default;

    const bad = await api("post", "/deposit", a.token).field("amount", "-5").field("transactionId", "t1");
    expect(bad.status).toBe(400);

    const ok = await api("post", "/deposit", a.token).field("amount", "50").field("userId", b.id).field("transactionId", "t2").field("accounttype", "manual");
    expect(ok.status).toBe(201);
    const dep = await Deposit.findOne({ transactionId: "t2" });
    expect(String(dep.userId)).toBe(a.id);
  });
});
