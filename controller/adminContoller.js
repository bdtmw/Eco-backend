import asyncHandler from "express-async-handler";
import User from "../model/UserModel.js";
import MiningMachine from "../model/MiningMachine.js";
import Transaction from "../model/withdrawals.js";
import Deposit from "../model/depositeModel.js"
import Contact from "../model/Contact.js";

export const deleteUser = asyncHandler(async (req ,res) => {
  const { id } = req.params;

  try {
    if (String(req.user._id) === String(id)) {
      return res.status(400).json({ message: "You cannot delete your own account" });
    }
    const user = await User.findByIdAndDelete(id);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    res.status(200).json({ message: "User deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: "Cannot Delete User" });
  }
});



export const getAllUsers = asyncHandler(async (req, res) => {
  try {
    const users = await User.find({}).select(
      "-password -otpCode -otpExpires -resetPasswordToken -resetPasswordExpires"
    );

    if (users.length === 0) {
      return res.status(404).json({ message: "No users found" });
    }

    res.status(200).json(users);
  } catch (error) {
    console.error("Error fetching users:", error.message);
    res.status(500).json({ message: "Server error" });
  }
});


export const getAdminStats = async (req, res) => {
  try {
    const totalUsers = await User.countDocuments();
    const totalMachines = await MiningMachine.countDocuments();
    const contacts = await Contact.countDocuments();

    // Count of deposit transactions
    const totalDeposits = await Transaction.countDocuments({
      type: "ADMIN_ADD",
      status: "approved" // ← only approved ones
    });

    // Count of withdrawal transactions
    const totalWithdrawals = await Transaction.countDocuments({
      type: "withdrawal",
      status: "approved" // ← only approved ones
    });

    // Total deposit AMOUNT (sum)
    const depositAmountResult = await Transaction.aggregate([
      { 
        $match: { 
          type: "ADMIN_ADD", 
          status: "approved" 
        } 
      },
      { 
        $group: { 
          _id: null, 
          total: { $sum: "$amount" } 
        } 
      }
    ]);

    // Total withdrawal AMOUNT (sum)
    const withdrawalAmountResult = await Transaction.aggregate([
      { 
        $match: { 
          type: "withdrawal", 
          status: "approved" 
        } 
      },
      { 
        $group: { 
          _id: null, 
          total: { $sum: "$amount" } 
        } 
      }
    ]);

    const totalDepositAmount = depositAmountResult[0]?.total ?? 0;
    const totalWithdrawalAmount = withdrawalAmountResult[0]?.total ?? 0;

    return res.status(200).json({
      success: true,
      stats: {
        totalUsers,
        totalMachines,
        contacts,
        // Counts
        totalDeposits,
        totalWithdrawals,
        // Amounts
        totalDepositAmount,
        totalWithdrawalAmount,
      },
    });

  } catch (error) {
    console.error("Admin Stats Error:", error);
    return res.status(500).json({ 
      success: false, 
      message: "Server Error" 
    });
  }
};
