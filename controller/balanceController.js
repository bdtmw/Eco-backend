import mongoose from 'mongoose';
import Balance from '../model/Balance.js';
import Transaction from '../model/withdrawals.js';
import UserMAchine from '../model/UserMAchine.js';
import User from "../model/UserModel.js";
import asyncHandler from "express-async-handler";
import { isSelfOrAdmin, isValidId, isPositiveNumber } from "../utils/access.js";

export const updateBalance = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { userId, amount } = req.body;

    // VALIDATION
    if (!isPositiveNumber(amount)) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: "Invalid amount" });
    }
    if (!isValidId(userId) || !(await User.exists({ _id: userId }))) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ message: "User not found" });
    }

    // FIND BALANCE RECORD
    let balance = await Balance.findOne({ user: userId }).session(session);
    if (!balance) {
      balance = new Balance({
        user: userId,
        totalBalance: 0,
        adminAdd: 0,
        miningBalance: 0,
      });
    }

    // CREATE TRANSACTION 
    const transaction = new Transaction({
      user: userId,
      amount: Math.abs(amount),
      type: "ADMIN_ADD",
      status: "approved",
      details: `Admin balance add: $${amount}`,
      transactionDate: new Date(),
    });

    // UPDATE CURRENT USER BALANCE
    balance.adminAdd += amount;
    balance.totalBalance = balance.adminAdd + balance.miningBalance;
    balance.lastUpdated = new Date();



    // --- REFERRAL BONUS LOGIC START ---
// console.log(">>> REFERRAL LOGIC START");

// const currentUser = await User.findById(userId).session(session);
// if (!currentUser) {
//   console.log("❌ currentUser not found");
// } else if (!currentUser.referralId) {
//   console.log("⚠️ currentUser has no referralId assigned");
// } else {
//   console.log("currentUser:", { id: currentUser._id, referralId: currentUser.referralId });

//   const referralUser = await User.findById(currentUser.referralId).session(session);
//   if (!referralUser) {
//     console.log("❌ referral user not found for id:", currentUser.referralId);
//   } else {
//     console.log("referralUser found:", referralUser._id);

//     // find or create referral balance
//     let referralBalance = await Balance.findOne({ user: referralUser._id }).session(session);
//     if (!referralBalance) {
//       console.log("Creating new referralBalance for referrer");
//       referralBalance = new Balance({
//         user: referralUser._id,
//         totalBalance: 0,
//         adminAdd: 0,
//         miningBalance: 0
//       });
//     } else {
//       console.log("Existing referralBalance:", referralBalance.totalBalance);
//     }

//     // Make sure amount is a number
//     const amt = Number(amount);
//     if (Number.isNaN(amt) || amt <= 0) {
//       console.log("Invalid amount for bonus calc:", amount);
//     } else {
//       // Count previous ADMIN_ADD transactions (before this one)
//       const adminUpdatesCount = await Transaction.countDocuments({
//         user: userId,
//         type: "ADMIN_ADD",
//         status: "approved"
//       }).session(session);

//       console.log("adminUpdatesCount (previous approved ADMIN_ADD):", adminUpdatesCount);

//       // Bonus percent: first time => 10% (0.10). Afterwards => 2% (0.02).
//       const bonusPercentage = adminUpdatesCount === 0 ? 0.10 : 0.02;

//       const bonusAmount = +(amt * bonusPercentage).toFixed(2); // round to 2 decimals
//       console.log(`Applying bonusPercentage: ${bonusPercentage} => bonusAmount: ${bonusAmount} on amount: ${amt}`);

//       referralBalance.totalBalance = (referralBalance.totalBalance || 0) + bonusAmount;
//       referralBalance.lastUpdated = new Date();

//       await referralBalance.save({ session });
//       console.log("Saved referralBalance. New totalBalance:", referralBalance.totalBalance);
//     }
//   }
// }

// console.log(">>> REFERRAL LOGIC END");
// --- REFERRAL BONUS LOGIC END ---



    // SAVE TRANSACTION + USER BALANCE
    await transaction.save({ session });
    await balance.save({ session });




// // ⭐⭐⭐ UPDATE USER DEPOSIT_COUNT + DISCOUNT ⭐⭐⭐
// const userToUpdate = await User.findById(userId).session(session);

// // deposit_count increase
// userToUpdate.deposit_count = (userToUpdate.deposit_count || 0) + 1;

// // -----------------------------
// // DISCOUNT AMOUNT LOGIC
// // -----------------------------
// let discountAmount = 0;

// if (userToUpdate.deposit_count === 1) {
//     // ⭐ First deposit → 10% amount
//     discountAmount = amount * 0.10;
// } else {
//     // ⭐ Second, third, onwards → 2% amount
//     discountAmount = amount * 0.02;
// }

// // Add discount amount cumulatively
// userToUpdate.discount = (userToUpdate.discount || 0) + discountAmount;

// await userToUpdate.save({ session });

// console.log("Updated user's deposit count & discount:", {
//   deposit_count: userToUpdate.deposit_count,
//   discount_added_this_time: discountAmount.toFixed(2),
//   total_discount: userToUpdate.discount.toFixed(2),
// });





    await session.commitTransaction();
    session.endSession();

    return res.status(200).json({
      message: "Admin balance added successfully 🤝",
    });

  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    console.log(error);
    return res.status(500).json({ message: "Error updating balance" });
  }
};




// Add this new controller for processing withdrawal requests
export const processWithdrawal = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { transactionId, status, adminComment } = req.body;
    const adminId = req.user._id; // Assuming you have admin user in request

    const transaction = await Transaction.findById(transactionId).session(session);
    if (!transaction || transaction.type !== 'withdrawal') {
      await session.abortTransaction();
      return res.status(404).json({ message: 'Withdrawal transaction not found' });
    }

    if (transaction.status !== 'pending') {
      await session.abortTransaction();
      return res.status(400).json({ message: 'Transaction already processed' });
    }

    const balance = await Balance.findOne({ user: transaction.user }).session(session);
    if (!balance) {
      await session.abortTransaction();
      return res.status(404).json({ message: 'Balance record not found' });
    }

    // Update transaction
    transaction.status = status;
    transaction.adminComment = adminComment;
    transaction.processedBy = adminId;
    transaction.processedAt = new Date();

    // If approved, process the withdrawal
    if (status === 'approved') {
      const amount = transaction.amount;
      const totalAvailable = balance.adminAdd + balance.miningBalance;
      
      if (amount > totalAvailable) {
        await session.abortTransaction();
        return res.status(400).json({ message: 'Insufficient funds' });
      }

      // First use mining balance
      const miningDeduction = Math.min(balance.miningBalance, amount);
      balance.miningBalance -= miningDeduction;
      
      // Then use main balance if needed
      const remainingAmount = amount - miningDeduction;
      if (remainingAmount > 0) {
        balance.adminAdd -= remainingAmount;
      }

      balance.totalBalance = balance.adminAdd + balance.miningBalance;
      balance.lastUpdated = new Date();

      await balance.save({ session });
    }

    await transaction.save({ session });
    await session.commitTransaction();

    return res.status(200).json({
      message: `Withdrawal ${status}`,
      transaction: transaction,
      balances: {
        total: balance.totalBalance,
        main: balance.adminAdd,
        mining: balance.miningBalance
      }
    });

  } catch (error) {
    await session.abortTransaction();
    console.error('Withdrawal processing error:', error);
    return res.status(500).json({ 
      message: 'Error processing withdrawal',
      error: error.message 
    });
  } finally {
    session.endSession();
  }
};

// Add this function to your balance controller
const initializeBalance = async (userId) => {
  const newBalance = new Balance({
    user: userId,
    totalBalance: 0,
    adminAdd: 0,
    miningBalance: 0,
    lastUpdated: new Date()
  });
  return await newBalance.save();
};


export const getBalance = async (req, res) => {
  try {
    const { userId } = req.params;

    if (!isValidId(userId) || !isSelfOrAdmin(req, userId)) {
      return res.status(403).json({ message: 'Not allowed' });
    }

    let balance = await Balance.findOne({ user: userId });
    if (!balance) {
      try {
        balance = await initializeBalance(userId);
      } catch (initError) {
        console.error('Failed to initialize balance:', initError);
        return res.status(500).json({ 
          message: 'Failed to initialize balance record',
          error: 'BALANCE_INIT_FAILED'
        });
      }
    }

    const machines = await UserMAchine.find({ 
      user: userId,
      status: 'active'
    }).populate('machine', 'machineName monthlyProfit');

    const machineDetails = machines.map(m => ({
      machineId: m._id,
      name: m.machine?.machineName,
      accumulatedProfit: m.monthlyProfitAccumulated || 0,
      lastProfitUpdate: m.lastProfitUpdate
    }));

    return res.status(200).json({
      balances: {
        total: balance.totalBalance,
        adminAdd: balance.adminAdd,
        mining: balance.miningBalance
      },
      machines: {
        count: machines.length,
        details: machineDetails
      },
      lastUpdated: balance.lastUpdated
    });

  } catch (error) {
    console.error('Error in getBalance:', error);
    return res.status(500).json({ 
      message: 'Error retrieving balance',
      error: 'BALANCE_FETCH_FAILED'
    });
  }
};





export const getAllBalance = asyncHandler(async (req, res) => {
  try {
    const users = await Balance.find({});

    if (users.length === 0) {
      return res.status(404).json({ message: "No Balance found" });
    }

    res.status(200).json(users);
  } catch (error) {
    console.error("Error fetching users:", error.message);
    res.status(500).json({ message: `Server error: ${error.message}` });
  }
});