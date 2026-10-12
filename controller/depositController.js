import crypto from "crypto";
import mongoose from "mongoose";
import Deposit from "../model/depositeModel.js";
import uploadToCloudinary from "../helper/cloudinary.js";
import User from "../model/UserModel.js";
import Balance from "../model/Balance.js";
import Transaction from "../model/withdrawals.js";
import asyncHandler from "express-async-handler";

const NOWPAYMENTS_BASE_URL = process.env.NOWPAYMENTS_BASE_URL || "https://api.nowpayments.io/v1";
const NOWPAYMENTS_API_KEY = process.env.NOWPAYMENTS_API_KEY;
const NOWPAYMENTS_IPN_SECRET = process.env.NOWPAYMENTS_IPN_SECRET;
const APP_BASE_URL = process.env.APP_BASE_URL || "http://localhost:3000";
const API_BASE_URL = process.env.API_BASE_URL || "http://localhost:8000";

const sortObject = (obj) => {
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(sortObject);

  return Object.keys(obj)
    .sort()
    .reduce((acc, key) => {
      acc[key] = sortObject(obj[key]);
      return acc;
    }, {});
};

const verifyNowPaymentsSignature = (body, signature) => {
  if (!NOWPAYMENTS_IPN_SECRET || !signature) return false;

  const sortedBody = JSON.stringify(sortObject(body));
  const hmac = crypto
    .createHmac("sha512", NOWPAYMENTS_IPN_SECRET)
    .update(sortedBody)
    .digest("hex");

  const a = Buffer.from(hmac);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

const creditUserBalance = async ({ userId, amount, paymentId, session }) => {
  let balance = await Balance.findOne({ user: userId }).session(session);

  if (!balance) {
    balance = new Balance({
      user: userId,
      totalBalance: 0,
      adminAdd: 0,
      miningBalance: 0,
    });
  }

  balance.adminAdd += Number(amount);
  balance.totalBalance = balance.adminAdd + balance.miningBalance;
  balance.lastUpdated = new Date();

  const transaction = new Transaction({
    user: userId,
    amount: Number(amount),
    type: "ADMIN_ADD",
    status: "approved",
    details: `NOWPayments deposit approved. Payment ID: ${paymentId}`,
    transactionDate: new Date(),
  });

  await transaction.save({ session });
  await balance.save({ session });
};

export const createDeposit = async (req, res) => {
  try {
    const { transactionId, dateTime, accounttype } = req.body;
    const userId = req.user._id;
    const amount = Number(req.body.amount);

    if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000) {
      return res.status(400).json({ success: false, message: "Invalid deposit amount" });
    }

    let attachmentUrls = [];

    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        const uploadedUrl = await uploadToCloudinary(file.buffer);
        attachmentUrls.push(uploadedUrl);
      }
    }

    const newDeposit = new Deposit({
      userId,
      amount,
      transactionId,
      accounttype,
      attachment: attachmentUrls,
      dateTime: new Date(),
      paymentProvider: "manual",
      paymentStatus: "pending",
    });

    await newDeposit.save();

    return res.status(201).json({
      success: true,
      message: "Deposit submitted successfully",
      data: newDeposit,
    });
  } catch (error) {
    console.error("❌ Deposit creation failed:", error);
    return res.status(500).json({
      success: false,
      message: "Error while creating deposit",
    });
  }
};

export const createNowPaymentsDeposit = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const { amount, payCurrency = "usdttrc20" } = req.body;

  if (!NOWPAYMENTS_API_KEY) {
    return res.status(500).json({ success: false, message: "NOWPayments API key is missing" });
  }

  if (!amount || Number(amount) <= 0) {
    return res.status(400).json({ success: false, message: "Invalid deposit amount" });
  }

  const user = await User.findById(userId);
  if (!user) {
    return res.status(404).json({ success: false, message: "User not found" });
  }

  const deposit = await Deposit.create({
    userId,
    amount: Number(amount),
    transactionId: `NP-${Date.now()}-${userId}`,
    accounttype: "NOWPayments",
    paymentProvider: "nowpayments",
    paymentStatus: "creating",
    payCurrency,
    dateTime: new Date(),
  });

  const callbackUrl = `${API_BASE_URL}/api/v1/nowpayments/ipn`;
  const payload = {
    price_amount: Number(amount),
    price_currency: "usd",
    pay_currency: payCurrency,
    ipn_callback_url: callbackUrl,
    order_id: deposit._id.toString(),
    order_description: `Deposit for ${user.email || userId}`,
    success_url: `${APP_BASE_URL}/deposit/success?depositId=${deposit._id}`,
    cancel_url: `${APP_BASE_URL}/deposit/cancel?depositId=${deposit._id}`,
  };

  const response = await fetch(`${NOWPAYMENTS_BASE_URL}/invoice`, {
    method: "POST",
    headers: {
      "x-api-key": NOWPAYMENTS_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json();

  if (!response.ok) {
    deposit.paymentStatus = "failed";
    deposit.nowPaymentsRaw = data;
    await deposit.save();

    return res.status(response.status).json({
      success: false,
      message: data?.message || "NOWPayments invoice creation failed",
      data,
    });
  }

  deposit.nowPaymentsInvoiceId = data.id || data.invoice_id;
  deposit.invoiceUrl = data.invoice_url;
  deposit.paymentStatus = "waiting";
  deposit.nowPaymentsRaw = data;
  await deposit.save();

  return res.status(201).json({
    success: true,
    message: "NOWPayments invoice created successfully",
    data: {
      depositId: deposit._id,
      invoiceId: deposit.nowPaymentsInvoiceId,
      invoiceUrl: deposit.invoiceUrl,
      status: deposit.paymentStatus,
    },
  });
});

export const nowPaymentsIpn = asyncHandler(async (req, res) => {
  const signature = req.headers["x-nowpayments-sig"];

  if (!verifyNowPaymentsSignature(req.body, signature)) {
    return res.status(401).json({ success: false, message: "Invalid NOWPayments signature" });
  }

  const {
    payment_id,
    invoice_id,
    order_id,
    payment_status,
    actually_paid,
    price_amount,
    pay_currency,
  } = req.body;

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const deposit = await Deposit.findById(order_id).session(session);
    if (!deposit) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ success: false, message: "Deposit not found" });
    }

    const alreadyFinished = deposit.paymentStatus === "finished";

    deposit.nowPaymentsPaymentId = payment_id || deposit.nowPaymentsPaymentId;
    deposit.nowPaymentsInvoiceId = invoice_id || deposit.nowPaymentsInvoiceId;
    deposit.paymentStatus = payment_status || deposit.paymentStatus;
    deposit.payCurrency = pay_currency || deposit.payCurrency;
    deposit.actuallyPaid = actually_paid || deposit.actuallyPaid;
    deposit.nowPaymentsRaw = req.body;

    if (payment_status === "finished" && !alreadyFinished) {
      await creditUserBalance({
        userId: deposit.userId,
        amount: price_amount || deposit.amount,
        paymentId: payment_id,
        session,
      });
    }

    await deposit.save({ session });
    await session.commitTransaction();
    session.endSession();

    return res.status(200).json({ success: true });
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    console.error("NOWPayments IPN error:", error);
    return res.status(500).json({ success: false, message: "IPN processing failed" });
  }
});

export const getDeposits = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const user = await User.findById(userId);

  if (!user) {
    return res.status(404).json({ message: "User not found" });
  }

  let deposits;

  if (user.role === "admin") {
    deposits = await Deposit.find()
      .populate("userId", "firstName lastName email")
      .sort({ createdAt: -1 });
  } else {
    deposits = await Deposit.find({ userId }).sort({ createdAt: -1 });
  }

  res.status(200).json({
    success: true,
    count: deposits.length,
    data: deposits,
  });
});
