import mongoose from "mongoose";
import User from "../model/UserModel.js";
import Transaction from "../model/withdrawals.js";
import Withdrawal from "../model/withdrawalModel.js";
import UserMachine from "../model/UserMAchine.js";
import { sendEmail } from "../helper/emailServer.js";
import Balance from "../model/Balance.js";
import asyncHandler from "express-async-handler";
import dotenv from 'dotenv';
import { isSelfOrAdmin, isValidId, isPositiveNumber, escapeHtml } from '../utils/access.js';

const ADMIN_EMAIL = process.env.ADMIN_EMAIL; // e.g. "admin@yourdomain.com"

export const createWithdrawalRequest = asyncHandler(async (req, res) => {
  const { amount, walletNumber, walletType, walletName } = req.body;

  if (
    !isPositiveNumber(amount) ||
    ![walletNumber, walletType, walletName].every((v) => typeof v === "string" && v.trim())
  ) {
    return res.status(400).json({ message: "Valid amount and wallet details are required" });
  }

  const userId = req.user._id;

  // Atomic check-and-deduct: prevents negative amounts and double-spend races
  const user = await User.findOneAndUpdate(
    { _id: userId, mainBalance: { $gte: amount } },
    { $inc: { mainBalance: -amount } },
    { new: true }
  );

  if (!user) {
    return res.status(400).json({ message: "Insufficient balance" });
  }

  let withdrawal;
  try {
    withdrawal = await Withdrawal.create({
      userId,
      amount,
      walletNumber: walletNumber.trim(),
      walletType: walletType.trim(),
      walletName: walletName.trim(),
    });
  } catch (err) {
    // Roll the deduction back if the request could not be recorded
    await User.updateOne({ _id: userId }, { $inc: { mainBalance: amount } });
    throw err;
  }

  res.status(201).json({
    message: "Withdrawal request submitted successfully",
    withdrawal,
  });
});




export const getWithdrawals = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const user = await User.findById(userId);

  if (!user) {
    return res.status(404).json({ message: "User not found" });
  }

  let withdrawals;

  if (user.role === "admin") {
    // Admin can view all withdrawals
    withdrawals = await Withdrawal.find()
      .populate("userId", "firstName lastName email")
      .sort({ createdAt: -1 });
  } else {
    // Regular user can only view their own withdrawals
    withdrawals = await Withdrawal.find({ userId })
      .sort({ createdAt: -1 });
  }

  res.status(200).json({
    success: true,
    count: withdrawals.length,
    data: withdrawals,
  });
});



export const updateWithdrawalStatus = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  if (!isValidId(id) || !["Approved", "Rejected"].includes(status)) {
    return res.status(400).json({ message: "Invalid request" });
  }

  // Only a Pending request can transition; this makes refunds happen at most once
  const withdrawal = await Withdrawal.findOneAndUpdate(
    { _id: id, status: "Pending" },
    { $set: { status } },
    { new: true }
  );

  if (!withdrawal) {
    const exists = await Withdrawal.exists({ _id: id });
    return res.status(exists ? 409 : 404).json({
      message: exists
        ? "Withdrawal request has already been processed"
        : "Withdrawal request not found",
    });
  }

  if (status === "Rejected") {
    await User.updateOne(
      { _id: withdrawal.userId },
      { $inc: { mainBalance: withdrawal.amount } }
    );
  }

  res.status(200).json({
    success: true,
    message: `Withdrawal request ${status.toLowerCase()} successfully`,
    data: withdrawal,
  });
});





// Request a new withdrawal
export const requestWithdrawal = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { amount, walletAddress, network } = req.body;

    // Basic validation
    if (
      !isPositiveNumber(amount) ||
      typeof walletAddress !== "string" || !walletAddress.trim() ||
      typeof network !== "string" || !network.trim()
    ) {
      await session.abortTransaction();
      return res.status(400).json({
        message: "Valid amount, wallet address, and network are required",
      });
    }

    // Always the authenticated user, never a client-supplied identity
    const user = await User.findById(req.user._id).session(session);

    if (!user) {
      await session.abortTransaction();
      return res.status(404).json({ message: "User not found" });
    }

    // Fetch user balance
    const balance = await Balance.findOne({ user: user._id }).session(session);

    if (!balance) {
      await session.abortTransaction();
      return res.status(404).json({ message: "Not Enough balance" });
    }

    // Funds already committed to other pending withdrawals
    const [pending] = await Transaction.aggregate([
      { $match: { user: user._id, type: "withdrawal", status: "pending" } },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]).session(session);
    const availableBalance = balance.totalBalance - (pending?.total || 0);

    // Check balance
    if (amount > availableBalance) {
      await session.abortTransaction();
      return res.status(400).json({
        message: "Withdrawal amount exceeds available balance",
        availableBalance,
      });
    }

    // Create pending withdrawal transaction
    const transaction = new Transaction({
      user: user._id,
      amount,
      type: "withdrawal",
      status: "pending",
      walletAddress: walletAddress.trim(),
      network: network.trim(),
      balanceBefore: balance.totalBalance,
      balanceAfter: balance.totalBalance - amount,
      details: `Withdrawal request of $${amount} via ${network}`,
    });

    await transaction.save({ session });
    await session.commitTransaction();

    // Send emails
    // Send email ONLY to admin
try {
  if (!ADMIN_EMAIL) {
    console.error("ADMIN_EMAIL is not set; skipping admin notification.");
  } else {
    const fullName = `${user.firstName || ""} ${user.lastName || ""}`.trim();
    const requestDate = new Date().toLocaleString();

   const adminHtml = `
  <div style="
    margin:0;
    padding:24px;
    background:#020617;
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
    color:#e5e7eb;
  ">
    <div style="
      max-width:640px;
      margin:0 auto;
      background:#020617;
      border-radius:12px;
      border:1px solid #1f2937;
      overflow:hidden;
      box-shadow:0 18px 45px rgba(0,0,0,0.7);
    ">
      <!-- Header -->
      <div style="
        padding:16px 24px;
        background:linear-gradient(90deg,#22c55e,#16a34a);
      ">
        <h2 style="
          margin:0;
          font-size:20px;
          font-weight:700;
          color:#022c22;
        ">
          New Withdrawal Request
        </h2>
        <p style="
          margin:4px 0 0;
          font-size:13px;
          color:#052e16;
        ">
          A user has submitted a new pending withdrawal request.
        </p>
      </div>

      <!-- Body -->
      <div style="padding:20px 24px 16px;">
        <!-- User section -->
        <h3 style="
          margin:0 0 10px;
          font-size:13px;
          text-transform:uppercase;
          letter-spacing:0.08em;
          color:#9ca3af;
        ">
          User Details
        </h3>
        <div style="
          border-radius:10px;
          border:1px solid #1f2937;
          background:#020617;
          padding:12px 14px;
          font-size:14px;
        ">
          <p style="margin:0 0 6px;">
            <span style="font-weight:600;color:#d1d5db;">User:</span>
            <span style="margin-left:6px;color:#e5e7eb;">
              ${escapeHtml(fullName || user.email)}
            </span>
          </p>
          <p style="margin:0;">
            <span style="font-weight:600;color:#d1d5db;">User Email:</span>
            <span style="margin-left:6px;color:#e5e7eb;">
              ${escapeHtml(user.email)}
            </span>
          </p>
        </div>

        <!-- Request info -->
        <h3 style="
          margin:18px 0 10px;
          font-size:13px;
          text-transform:uppercase;
          letter-spacing:0.08em;
          color:#9ca3af;
        ">
          Withdrawal Details
        </h3>
        <div style="
          border-radius:10px;
          border:1px solid #1f2937;
          background:#020617;
          padding:12px 14px;
          font-size:14px;
        ">
          <p style="margin:0 0 6px;">
            <span style="font-weight:600;color:#d1d5db;">Amount:</span>
            <span style="margin-left:6px;color:#22c55e;">
              $${escapeHtml(amount)}
            </span>
          </p>
          <p style="margin:0 0 6px;">
            <span style="font-weight:600;color:#d1d5db;">Wallet Address:</span>
            <span style="margin-left:6px;color:#e5e7eb;word-break:break-all;">
              ${escapeHtml(walletAddress)}
            </span>
          </p>
          <p style="margin:0 0 6px;">
            <span style="font-weight:600;color:#d1d5db;">Network:</span>
            <span style="margin-left:6px;color:#e5e7eb;">
              ${escapeHtml(network)}
            </span>
          </p>
          <p style="margin:0 0 6px;">
            <span style="font-weight:600;color:#d1d5db;">Transaction ID:</span>
            <span style="margin-left:6px;color:#e5e7eb;">
              ${transaction._id}
            </span>
          </p>
          <p style="margin:0;">
            <span style="font-weight:600;color:#d1d5db;">Requested At:</span>
            <span style="margin-left:6px;color:#e5e7eb;">
              ${requestDate}
            </span>
          </p>
        </div>

        <!-- Footer note -->
        <p style="
          margin:18px 0 4px;
          font-size:13px;
          color:#9ca3af;
        ">
          This is an automatic notification of a new <span style="color:#22c55e;">pending withdrawal</span>.
        </p>
        <p style="
          margin:0 0 4px;
          font-size:12px;
          color:#6b7280;
        ">
          Please review this request in the admin panel and approve or reject it as appropriate.
        </p>
      </div>
    </div>
  </div>
`;

    await sendEmail(
      ADMIN_EMAIL,
      "Withdrawal Request Submitted",
      adminHtml   // <-- actual HTML with user details
    );
  }
} catch (emailError) {
  console.error("Email send failed:", emailError);
}

    return res.status(200).json({
      message: "Withdrawal request submitted successfully",
      transaction,
      availableBalance: availableBalance - amount,
    });
  } catch (error) {
    await session.abortTransaction();
    console.error("Withdrawal request error:", error);
    return res.status(500).json({
      message: "Error processing withdrawal request",
    });
  } finally {
    session.endSession();
  }
};


///
export const processWithdrawalRequest = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { transactionId, action, adminComment } = req.body;
    const adminId = req.user._id;

    if (!isValidId(transactionId) || !["approved", "rejected"].includes(action)) {
      await session.abortTransaction();
      return res.status(400).json({ message: "Invalid request" });
    }
    if (adminComment !== undefined && typeof adminComment !== "string") {
      await session.abortTransaction();
      return res.status(400).json({ message: "Invalid comment" });
    }

    const transaction = await Transaction.findById(transactionId)
      .session(session)
      .populate("user");

    if (!transaction) {
      await session.abortTransaction();
      return res.status(404).json({ message: "Transaction not found" });
    }

    if (transaction.type !== "withdrawal") {
      await session.abortTransaction();
      return res.status(400).json({ message: "Not a withdrawal transaction" });
    }

    if (transaction.status !== "pending") {
      await session.abortTransaction();
      return res
        .status(400)
        .json({ message: "Transaction is no longer pending" });
    }

    const balance = await Balance.findOne({
      user: transaction.user._id,
    }).session(session);

    if (action === "approved") {
      if (!balance) {
        await session.abortTransaction();
        return res.status(404).json({ message: "Balance record not found" });
      }
      if (transaction.amount > balance.totalBalance) {
        await session.abortTransaction();
        return res.status(400).json({
          message: "Insufficient balance",
          available: balance.totalBalance,
        });
      }

      // Deduct from balances - first from mining balance then from main if needed
      let remainingAmount = transaction.amount;

// Deduct from mining balance first
const miningDeduction = Math.min(balance.miningBalance, remainingAmount);
balance.miningBalance -= miningDeduction;
remainingAmount -= miningDeduction;

// Deduct the rest from main/admin balance
if (remainingAmount > 0) {
  const mainDeduction = Math.min(balance.adminAdd, remainingAmount);
  balance.adminAdd -= mainDeduction;
  remainingAmount -= mainDeduction;
}


      // Final safety check (should never happen)
      if (remainingAmount > 0) {
        await session.abortTransaction();
        return res.status(400).json({
          message: "Insufficient balance after recalculation"
        });
      }

      balance.totalBalance = balance.adminAdd + balance.miningBalance;
      await balance.save({ session });

    }

    // Update transaction
    transaction.status = action;
    transaction.adminComment = adminComment;
    transaction.processedBy = adminId;
    transaction.processedAt = new Date();
    await transaction.save({ session });

    await session.commitTransaction();

    
   // Send email notification
try {
  const statusLabel = action === "approved" ? "approved" : "rejected";
  const amount = transaction.amount;
  const fullName = `${transaction.user.firstName || ""} ${
    transaction.user.lastName || ""
  }`.trim();

 const html = `
  <div style="
    margin:0;
    padding:24px;
    background:#0b1120;
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
    color:#e5e7eb;
  ">
    <div style="
      max-width:620px;
      margin:0 auto;
      background:#020617;
      border-radius:12px;
      border:1px solid #1f2937;
      overflow:hidden;
      box-shadow:0 18px 45px rgba(0,0,0,0.7);
    ">
      <!-- Header -->
      <div style="
        padding:16px 24px;
        background:linear-gradient(90deg,#22c55e,#16a34a);
      ">
        <h2 style="
          margin:0;
          font-size:20px;
          font-weight:700;
          color:#022c22;
        ">
          Withdrawal Request ${
            statusLabel.charAt(0).toUpperCase() + statusLabel.slice(1)
          }
        </h2>
        <p style="
          margin:4px 0 0;
          font-size:13px;
          color:#052e16;
        ">
          This is an update on your recent withdrawal request.
        </p>
      </div>

      <!-- Body -->
      <div style="padding:20px 24px 18px;">
        <p style="margin:0 0 10px;font-size:14px;color:#e5e7eb;">
          Hi ${escapeHtml(fullName) || "there"},
        </p>

        <p style="margin:0 0 16px;font-size:14px;color:#e5e7eb;">
          Your withdrawal request has been
          <span style="font-weight:600;color:${
            statusLabel === "approved" ? "#22c55e" : "#f97373"
          };">
            ${statusLabel}
          </span>.
        </p>

        <!-- Details card -->
        <div style="
          border-radius:10px;
          border:1px solid #1f2937;
          background:#020617;
          padding:12px 14px;
          font-size:14px;
        ">
          <p style="margin:0 0 6px;">
            <span style="font-weight:600;color:#d1d5db;">Amount:</span>
            <span style="margin-left:6px;color:#22c55e;">
              $${amount}
            </span>
          </p>
          <p style="margin:0 0 6px;">
            <span style="font-weight:600;color:#d1d5db;">Transaction ID:</span>
            <span style="margin-left:6px;color:#e5e7eb;">
              ${transaction._id}
            </span>
          </p>
          ${
            adminComment
              ? `<p style="margin:4px 0 0;">
                   <span style="font-weight:600;color:#d1d5db;">Note from admin:</span>
                   <span style="margin-left:6px;color:#e5e7eb;">
                     ${escapeHtml(adminComment)}
                   </span>
                 </p>`
              : ""
          }
        </div>

        <p style="
          margin:18px 0 4px;
          font-size:13px;
          color:#9ca3af;
        ">
          If you did not request this withdrawal, please contact our support team immediately.
        </p>
        <p style="
          margin:0;
          font-size:12px;
          color:#6b7280;
        ">
          This is an automated message, please do not reply directly to this email.
        </p>
      </div>
    </div>
  </div>
`;

  await sendEmail(
    transaction.user.email,
    `Withdrawal Request ${statusLabel.toUpperCase()}`,
    html
  );
} catch (emailError) {
  console.error("Email notification failed:", emailError);
}

    return res.status(200).json({
      message: `Withdrawal request ${action} successfully`,
      transaction: transaction,
    });
  } catch (error) {
    await session.abortTransaction();
    console.error("Withdrawal processing error:", error);
    return res.status(500).json({
      message: "Error processing withdrawal request"
    });
  } finally {
    session.endSession();
  }
};

// Get all pending withdrawal requests (for admin)
export const getPendingWithdrawals = async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;

    const withdrawals = await Transaction.find({
      type: "withdrawal",
      status: "pending",
    })
      .sort({ transactionDate: -1 })
      .skip((parseInt(page) - 1) * parseInt(limit))
      .limit(parseInt(limit))
      .populate("user", "firstName lastName email");

    const total = await Transaction.countDocuments({
      type: "withdrawal",
      status: "pending",
    });

    res.status(200).json({
      withdrawals,
      totalPages: Math.ceil(total / parseInt(limit)),
      currentPage: parseInt(page),
      totalWithdrawals: total,
    });
  } catch (error) {
    console.error("Error retrieving pending withdrawals:", error);
    res.status(500).json({
      message: "Error retrieving pending withdrawals"
    });
  }
};

// Get user's withdrawal history
// In withdrawalController.js
export const getUserWithdrawals = async (req, res) => {
  try {
    const { page = 1, limit = 10 } = req.query;
    const email = typeof req.query.email === "string" ? req.query.email : "";

    // Non-admins can only see their own history
    const targetEmail =
      req.user.role === "admin" && email ? email : req.user.email;

    const user = await User.findOne({ email: targetEmail.toLowerCase() });

    if (!user) {
      return res.status(404).json({
        message: "User not found with provided email",
      });
    }

    // Parse pagination values safely (JS, no type assertions)
    const numericPage = Number(page) || 1;
    const numericLimit = Math.min(Number(limit) || 10, 100);

    // We want both withdrawals and admin credits
    const types = ["withdrawal", "ADMIN_ADD"];

    // Get paginated transactions
    const withdrawals = await Transaction.find({
      user: user._id,
      type: { $in: types },
    })
      .sort({ transactionDate: -1 })
      .skip((numericPage - 1) * numericLimit)
      .limit(numericLimit)
      .populate("user", "email firstName lastName");

    // Total count for pagination
    const total = await Transaction.countDocuments({
      user: user._id,
      type: { $in: types },
    });

    res.status(200).json({
      withdrawals, // includes both withdrawal & ADMIN_ADD
      totalPages: Math.ceil(total / numericLimit),
      currentPage: numericPage,
      totalTransactions: total,
    });
  } catch (error) {
    console.error("Error retrieving user withdrawals:", error);
    res.status(500).json({
      message: "Error retrieving withdrawal history"
    });
  }
};

// Get withdrawal statistics (for admin)
export const getWithdrawalStats = async (req, res) => {
  try {
    const [
      pendingCount,
      pendingAmount,
      approvedCount,
      approvedAmount,
      rejectedCount,
    ] = await Promise.all([
      Transaction.countDocuments({ type: "withdrawal", status: "pending" }),
      Transaction.aggregate([
        { $match: { type: "withdrawal", status: "pending" } },
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ]),
      Transaction.countDocuments({ type: "withdrawal", status: "approved" }),
      Transaction.aggregate([
        { $match: { type: "withdrawal", status: "approved" } },
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ]),
      Transaction.countDocuments({ type: "withdrawal", status: "rejected" }),
    ]);

    res.status(200).json({
      pending: {
        count: pendingCount,
        amount: pendingAmount[0]?.total || 0,
      },
      approved: {
        count: approvedCount,
        amount: approvedAmount[0]?.total || 0,
      },
      rejected: {
        count: rejectedCount,
      },
    });
  } catch (error) {
    console.error("Error retrieving withdrawal statistics:", error);
    res.status(500).json({
      message: "Error retrieving withdrawal statistics"
    });
  }
};

// Add this to your withdrawalController.js file
export const getAllWithdrawals = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      startDate,
      endDate,
      status,
      sortBy = "transactionDate",
      sortOrder = "desc",
    } = req.query;

    // Build filter object
    const filter = { type: "withdrawal" };

    // Add date range filter if provided
    if (startDate || endDate) {
      filter.transactionDate = {};
      if (startDate) filter.transactionDate.$gte = new Date(startDate);
      if (endDate) filter.transactionDate.$lte = new Date(endDate);
    }

    // Add status filter if provided
    if (status && ["pending", "approved", "rejected"].includes(status)) {
      filter.status = status;
    }

    // Build sort object
    const sort = {};
    sort[sortBy] = sortOrder === "asc" ? 1 : -1;

    // Execute query with pagination
    const withdrawals = await Transaction.find(filter)
      .sort(sort)
      .skip((parseInt(page) - 1) * parseInt(limit))
      .limit(parseInt(limit))
      .populate("user", "firstName lastName email")
      .populate("processedBy", "firstName lastName email");

    // Get total count for pagination
    const total = await Transaction.countDocuments(filter);

    // Calculate total amount
    const totalAmount = await Transaction.aggregate([
      { $match: filter },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]);

    res.status(200).json({
      withdrawals,
      totalPages: Math.ceil(total / parseInt(limit)),
      currentPage: parseInt(page),
      totalWithdrawals: total,
      totalAmount: totalAmount[0]?.total || 0,
      filters: {
        startDate,
        endDate,
        status,
      },
      sorting: {
        sortBy,
        sortOrder,
      },
    });
  } catch (error) {
    console.error("Error retrieving all withdrawals:", error);
    res.status(500).json({
      message: "Error retrieving withdrawals"
    });
  }
};

// Get balance update history
export const getBalanceHistory = async (req, res) => {
  try {
    const { startDate, endDate, page = 1, limit = 20 } = req.query;
    const userId = typeof req.query.userId === "string" ? req.query.userId : undefined;

    const filter = {};
    if (req.user.role === "admin") {
      if (userId) {
        if (!isValidId(userId)) {
          return res.status(400).json({ message: "Invalid user id" });
        }
        filter.user = userId;
      }
    } else {
      // Regular users only ever see their own history
      filter.user = req.user._id;
    }
    if (startDate || endDate) {
      filter.processedAt = {};
      if (startDate) filter.processedAt.$gte = new Date(startDate);
      if (endDate) filter.processedAt.$lte = new Date(endDate);
    }

    // Get both profit-type transactions (admin updates) and machine profits
    const transactions = await Transaction.find(filter)
      .sort({ processedAt: -1 })
      .skip((parseInt(page) - 1) * parseInt(limit))
      .limit(parseInt(limit))
      .populate("user", "firstName lastName email")
      .populate("processedBy", "firstName lastName email");

    const total = await Transaction.countDocuments(filter);

    res.status(200).json({
      transactions,
      totalPages: Math.ceil(total / parseInt(limit)),
      currentPage: parseInt(page),
      totalTransactions: total,
    });
  } catch (error) {
    console.error("Error retrieving balance history:", error);
    res.status(500).json({
      message: "Error retrieving balance history"
    });
  }
};
