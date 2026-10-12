import mongoose from 'mongoose';
import MiningMachine from '../model/MiningMachine.js';
import SharePurchase from '../model/SharePurchase.js';
import Balance from '../model/Balance.js';
import Transaction from '../model/withdrawals.js';
import User from '../model/UserModel.js';
import { sendEmail } from '../helper/emailServer.js';
import { StatusCodes } from 'http-status-codes';
import { isSelfOrAdmin, isValidId, isPositiveInt, escapeHtml } from '../utils/access.js';

// Total shares currently held (sum, not document count)
const countSoldShares = async (machineId, session) => {
  const q = SharePurchase.aggregate([
    { $match: { machine: machineId, status: 'active' } },
    { $group: { _id: null, total: { $sum: '$numberOfShares' } } },
  ]);
  if (session) q.session(session);
  const r = await q;
  return r[0]?.total || 0;
};

// Get the special share machine
export const getSpecialShareMachine = async (req, res) => {
  try {
    const specialMachine = await MiningMachine.findOne({ 
      isShareBased: true,
      priceRange: 19000,
      sharePrice: 50
    });

    if (!specialMachine) {
      return res.status(StatusCodes.NOT_FOUND).json({
        success: false,
        message: "Special share machine not found"
      });
    }

    // Get sold shares
    const soldShares = await countSoldShares(specialMachine._id);

    // Calculate availability
    const availableShares = specialMachine.totalShares - soldShares;

    res.status(StatusCodes.OK).json({
      success: true,
      data: {
        ...specialMachine.toObject(),
        availableShares,
        soldShares
      }
    });
  } catch (error) {
    console.error("Error fetching special share machine:", error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      success: false,
      message: error.message
    });
  }
};

// Purchase shares of the special machine
export const purchaseSpecialShares = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { numberOfShares } = req.body;
    const userId = req.user._id;

    if (!isPositiveInt(numberOfShares)) {
      await session.abortTransaction();
      return res.status(StatusCodes.BAD_REQUEST).json({
        success: false,
        message: "User ID and valid number of shares are required"
      });
    }

    const user = await User.findById(userId).session(session);
    if (!user) {
      await session.abortTransaction();
      return res.status(StatusCodes.NOT_FOUND).json({
        success: false,
        message: "User not found"
      });
    }

    const machine = await MiningMachine.findOneAndUpdate(
      {
        isShareBased: true,
        priceRange: 19000,
        sharePrice: 50
      },
      { $set: { lastChecked: new Date() } },
      { session, new: true, runValidators: true }
    );

    if (!machine) {
      await session.abortTransaction();
      return res.status(StatusCodes.NOT_FOUND).json({
        success: false,
        message: "Special share machine not found"
      });
    }

    const soldShares = await countSoldShares(machine._id, session);

    const availableShares = machine.totalShares - soldShares;

    if (numberOfShares > availableShares) {
      await session.abortTransaction();
      return res.status(StatusCodes.BAD_REQUEST).json({
        success: false,
        message: `Only ${availableShares} shares available for purchase`
      });
    }

    const sharePrice = machine.sharePrice;
    const totalCost = sharePrice * numberOfShares;
    const monthlyProfitPerShare = machine.profitPerShare;
    const expectedMonthlyProfit = monthlyProfitPerShare * numberOfShares;

    let balance = await Balance.findOneAndUpdate(
      { user: userId },
      { $set: { lastChecked: new Date() } },
      {
        session,
        new: true,
        upsert: true,
        setDefaultsOnInsert: true
      }
    );

    if (!balance) {
      balance = new Balance({
        user: userId,
        totalBalance: 0,
        adminAdd: 0,
        miningBalance: 0,
        lastUpdated: new Date()
      });
    }

    if (balance.adminAdd < totalCost) {
      await session.abortTransaction();
      return res.status(StatusCodes.BAD_REQUEST).json({
        success: false,
        message: "Insufficient balance",
        required: totalCost,
        available: balance.adminAdd
      });
    }

    const sharePurchase = await SharePurchase.create(
      [
        {
          user: userId,
          machine: machine._id,
          numberOfShares,
          pricePerShare: sharePrice,
          profitPerShare: monthlyProfitPerShare,
          totalInvestment: totalCost,
          purchaseDate: new Date(),
          lastProfitUpdate: new Date(),
          status: "active"
        }
      ],
      { session }
    );

    const transaction = await Transaction.create(
      [
        {
          user: userId,
          amount: totalCost,
          type: "SHARE_PURCHASE",
          status: "completed",
          balanceBefore: balance.totalBalance,
          balanceAfter: balance.totalBalance - totalCost,
          details: `Purchased ${numberOfShares} shares of ${machine.machineName}`,
          transactionDate: new Date(),
          metadata: {
            machineId: machine._id,
            machineName: machine.machineName,
            shares: numberOfShares,
            pricePerShare: sharePrice
          }
        }
      ],
      { session }
    );

    balance.adminAdd -= totalCost;
    balance.totalBalance = balance.adminAdd + balance.miningBalance;
    balance.lastUpdated = new Date();
    await balance.save({ session });

    // Send email confirmation
    try {
      console.log("[SharePurchase] Preparing email for:", user.email);

      const emailData = {
        userName: `${user.firstName || ""} ${user.lastName || ""}`.trim(),
        machineName: machine.machineName,
        numberOfShares,
        pricePerShare: machine.sharePrice,
        totalCost: numberOfShares * machine.sharePrice
      };

     const html = `
  <div style="
    margin:0;
    padding:0;
    background:#050810;
    font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
    color:#e5e7eb;
  ">
    <div style="max-width:600px;margin:0 auto;padding:24px 16px;">
      <!-- Logo / Brand -->
      <div style="text-align:center;margin-bottom:20px;">
        <span style="
          display:inline-block;
          padding:8px 14px;
          border-radius:999px;
          background:rgba(34,197,94,0.08);
          border:1px solid rgba(34,197,94,0.35);
          color:#4ade80;
          font-size:12px;
          letter-spacing:0.08em;
          text-transform:uppercase;
        ">
          The Eco Mining
        </span>
      </div>

      <!-- Card -->
      <div style="
        background:#050816;
        border-radius:16px;
        border:1px solid #1f2937;
        box-shadow:0 24px 60px rgba(0,0,0,0.75);
        padding:24px 20px 20px;
      ">
        <h2 style="
          margin:0 0 12px 0;
          font-size:20px;
          font-weight:700;
          color:#4ade80;
        ">
          Share Purchase Confirmation
        </h2>

        <p style="margin:0 0 10px 0;font-size:14px;color:#d1d5db;">
          Hi ${emailData.userName || "there"},
        </p>
        <p style="margin:0 0 18px 0;font-size:14px;color:#9ca3af;line-height:1.6;">
          Thank you for purchasing shares in
          <span style="color:#f9fafb;font-weight:600;">
            ${emailData.machineName}
          </span>.
          Your investment has been added to your shared machines portfolio.
        </p>

        <!-- Details box -->
        <div style="
          margin:0 0 18px 0;
          padding:14px 14px 12px;
          border-radius:12px;
          background:linear-gradient(135deg,#020617,#020617 40%,#064e3b33);
          border:1px solid #111827;
        ">
          <p style="margin:0 0 6px 0;font-size:13px;color:#9ca3af;">
            <span style="color:#e5e7eb;font-weight:600;">Shares Purchased:</span>
            <span style="float:right;color:#f9fafb;font-weight:600;">
              ${emailData.numberOfShares}
            </span>
          </p>
          <p style="margin:0 0 6px 0;font-size:13px;color:#9ca3af;clear:both;">
            <span style="color:#e5e7eb;font-weight:600;">Price per Share:</span>
            <span style="float:right;color:#f9fafb;">
              $${emailData.pricePerShare}
            </span>
          </p>
          <p style="margin:0;font-size:13px;color:#9ca3af;clear:both;">
            <span style="color:#e5e7eb;font-weight:600;">Total Cost:</span>
            <span style="
              float:right;
              color:#4ade80;
              font-weight:700;
            ">
              $${emailData.totalCost}
            </span>
          </p>
        </div>

        <p style="margin:0 0 12px 0;font-size:13px;color:#9ca3af;line-height:1.6;">
          You can view this shared machine and track your earnings directly
          from your dashboard under
          <span style="color:#e5e7eb;font-weight:500;">Shared Machines</span>.
        </p>

        <p style="margin:0 0 4px 0;font-size:12px;color:#6b7280;">
          If you did not perform this transaction, please contact support
          immediately.
        </p>
      </div>

      <!-- Footer -->
      <p style="margin:16px 0 0 0;font-size:11px;color:#6b7280;text-align:center;">
        © ${new Date().getFullYear()} The Eco Mining. All rights reserved.
      </p>
    </div>
  </div>
`;

      console.log("[SharePurchase] Email HTML preview:", html.slice(0, 200));

      await sendEmail(
        user.email,
        "Share Purchase Confirmation",
        html
      );

      console.log("[SharePurchase] Email sent successfully to:", user.email);
    } catch (emailError) {
      console.error("[SharePurchase] Email sending failed:", emailError);
      // Continue even if email fails
    }

    await session.commitTransaction();

    return res.status(StatusCodes.CREATED).json({
      success: true,
      message: "Shares purchased successfully",
      data: {
        purchase: sharePurchase[0],
        transaction: transaction[0],
        newBalance: balance.totalBalance,
        expectedMonthlyProfit
      }
    });
  } catch (error) {
    await session.abortTransaction();
    console.error("Share purchase error:", error);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      success: false,
      message: "Error purchasing shares"
    });
  } finally {
    session.endSession();
  }
};

// Update profits for all share purchases (run this daily)
export const updateAllShareProfits = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const currentDate = new Date();
    // Changed from 1 hour to 30 days
    const thirtyDaysAgo = new Date(currentDate - 30 * 24 * 60 * 60 * 1000);

    const eligibleShares = await SharePurchase.find({
      status: 'active',
      lastProfitUpdate: { $lt: thirtyDaysAgo }
    }).populate('user').session(session);

    if (eligibleShares.length === 0) {
      await session.abortTransaction();
      return res.status(StatusCodes.OK).json({
        success: true,
        message: "No shares eligible for profit update",
        updatedCount: 0
      });
    }

    const updates = [];
    
    for (const share of eligibleShares) {
      // This is now the full monthly profit
      const profitAmount = share.numberOfShares * share.profitPerShare;
      
      const balance = await Balance.findOne({ user: share.user._id }).session(session);
      if (!balance) continue;

      // Update balances
      balance.miningBalance += profitAmount;
      balance.totalBalance = balance.adminAdd + balance.miningBalance;
      balance.lastUpdated = currentDate;
      await balance.save({ session });

      // Update share purchase record with cumulative profit
      share.totalProfitEarned += profitAmount;
      share.lastProfitUpdate = currentDate;
      await share.save({ session });

      // Record transaction
      await Transaction.create([{
        user: share.user._id,
        amount: profitAmount,
        type: 'SHARE_PROFIT',
        status: 'completed',
        balanceBefore: balance.totalBalance - profitAmount,
        balanceAfter: balance.totalBalance,
        details: `Monthly profit from ${share.numberOfShares} shares`,
        transactionDate: currentDate,
        metadata: {
          shareId: share._id,
          shares: share.numberOfShares,
          profitPerShare: share.profitPerShare
        }
      }], { session });

      updates.push({
        shareId: share._id,
        profitAdded: profitAmount,
        totalProfit: share.totalProfitEarned
      });
    }

    await session.commitTransaction();
    
    return res.status(StatusCodes.OK).json({
      success: true,
      message: "Share profits updated successfully",
      updatedCount: updates.length,
      updates: updates
    });

  } catch (error) {
    await session.abortTransaction();
    console.error("Error updating share profits:", error);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      success: false,
      message: "Error updating share profits"
    });
  } finally {
    session.endSession();
  }
};


export const getUserShareDetails = async (req, res) => {
  try {
    const { userId } = req.params;
    
    if (!isValidId(userId)) {
      return res.status(StatusCodes.BAD_REQUEST).json({
        success: false,
        message: "Valid user ID is required"
      });
    }

    if (!isSelfOrAdmin(req, userId)) {
      return res.status(StatusCodes.FORBIDDEN).json({
        success: false,
        message: "Not allowed"
      });
    }
    
    const shares = await SharePurchase.find({
      user: userId,
      status: 'active'
    }).populate('machine', 'machineName sharePrice profitPerShare');

    if (!shares || shares.length === 0) {
      return res.status(StatusCodes.OK).json({
        success: true,
        data: {
          shares: [],
          summary: {
            totalShares: 0,
            totalInvestment: 0,
            totalProfitEarned: 0,
            expectedMonthlyProfit: 0
          }
        }
      });
    }
    
    // Calculate summary statistics
    const summary = shares.reduce((acc, share) => {
      acc.totalShares += share.numberOfShares;
      acc.totalInvestment += share.totalInvestment;
      acc.totalProfitEarned += share.totalProfitEarned;
      acc.expectedMonthlyProfit += share.numberOfShares * share.profitPerShare ;
      return acc;
    }, {
      totalShares: 0,
      totalInvestment: 0,
      totalProfitEarned: 0,
      expectedMonthlyProfit: 0
    });

    // Format individual share details
    const shareDetails = shares.map(share => ({
      id: share._id,
      machineName: share.machine.machineName,
      numberOfShares: share.numberOfShares,
      pricePerShare: share.pricePerShare,
      profitPerShare: share.profitPerShare,
      totalInvestment: share.totalInvestment,
      totalProfitEarned: share.totalProfitEarned, 
      purchaseDate: share.purchaseDate,
      lastProfitUpdate: share.lastProfitUpdate,
      nextProfitUpdate: new Date(share.lastProfitUpdate.getTime() + 30 * 24 * 60 * 60 * 1000)
    }));

    return res.status(StatusCodes.OK).json({
      success: true,
      data: {
        shares: shareDetails,
        summary: {
          ...summary,
          expectedMonthlyProfit: Number(summary.expectedMonthlyProfit.toFixed(2))
        }
      }
    });
    
  } catch (error) {
    console.error("Error fetching user share details:", error);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      success: false,
      message: "Error retrieving share details"
    });
  }
};


// Sell shares of a mining machine
export const sellSharePurchase = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { sharePurchaseId } = req.params;
    const { numberOfSharesToSell } = req.body;
    
    // Validate numberOfSharesToSell is provided and is a positive number
    if (!isValidId(sharePurchaseId) || !isPositiveInt(numberOfSharesToSell)) {
      await session.abortTransaction();
      return res.status(StatusCodes.BAD_REQUEST).json({
        success: false,
        message: "Valid number of shares to sell is required"
      });
    }
    
    // Find the share purchase with related documents
    const sharePurchase = await SharePurchase.findById(sharePurchaseId)
      .populate('user')
      .populate('machine')
      .session(session);

    if (!sharePurchase || !isSelfOrAdmin(req, sharePurchase.user?._id)) {
      await session.abortTransaction();
      return res.status(StatusCodes.NOT_FOUND).json({
        success: false,
        message: 'Share purchase not found'
      });
    }

    if (sharePurchase.status !== 'active') {
      await session.abortTransaction();
      return res.status(StatusCodes.BAD_REQUEST).json({
        success: false,
        message: 'Cannot sell inactive shares'
      });
    }
    
    // Ensure user isn't trying to sell more shares than they own
    if (numberOfSharesToSell > sharePurchase.numberOfShares) {
      await session.abortTransaction();
      return res.status(StatusCodes.BAD_REQUEST).json({
        success: false,
        message: `You only own ${sharePurchase.numberOfShares} shares`
      });
    }

    // Calculate selling price with 10% deduction
    const originalValue = sharePurchase.pricePerShare * numberOfSharesToSell;
    const sellingPrice = originalValue * 0.9;
    const deduction = originalValue * 0.1;

    // Find user balance
    const balance = await Balance.findOne({ user: sharePurchase.user._id }).session(session);
    if (!balance) {
      await session.abortTransaction();
      return res.status(StatusCodes.NOT_FOUND).json({
        success: false,
        message: 'User balance not found'
      });
    }

    // Create transaction record
    const saleTransaction = await Transaction.create([{
      user: sharePurchase.user._id,
      amount: sellingPrice,
      type: 'SHARE_SALE',
      status: 'completed',
      balanceBefore: balance.totalBalance,
      balanceAfter: balance.totalBalance + sellingPrice,
      details: `Sold ${numberOfSharesToSell} shares of ${sharePurchase.machine.machineName}`,
      transactionDate: new Date(),
      metadata: {
        machineId: sharePurchase.machine._id,
        machineName: sharePurchase.machine.machineName,
        shareId: sharePurchase._id,
        originalShares: sharePurchase.numberOfShares,
        soldShares: numberOfSharesToSell,
        originalValue: originalValue,
        deduction: deduction,
        sellingPrice: sellingPrice
      }
    }], { session });

    // Update user balance
    balance.adminAdd += sellingPrice;
    balance.totalBalance = balance.adminAdd + balance.miningBalance;
    balance.lastUpdated = new Date();
    await balance.save({ session });

    // Handle partial or complete share sales
    if (numberOfSharesToSell === sharePurchase.numberOfShares) {
      // All shares sold - mark as inactive
      sharePurchase.status = 'inactive';
      await sharePurchase.save({ session });
    } else {
      // Partial sale - reduce share count and update total investment
      const remainingShares = sharePurchase.numberOfShares - numberOfSharesToSell;
      const remainingInvestment = sharePurchase.pricePerShare * remainingShares;
      
      sharePurchase.numberOfShares = remainingShares;
      sharePurchase.totalInvestment = remainingInvestment;
      await sharePurchase.save({ session });
    }

    await session.commitTransaction();

    // Send email confirmation
    try {
      await sendEmail(
        sharePurchase.user.email,
        "Share Sale Confirmation",
        `<div style="font-family:sans-serif;line-height:1.5">
          <h2>Share Sale Confirmation</h2>
          <p>Hi ${escapeHtml(sharePurchase.user.firstName) || "there"},</p>
          <p>You sold <b>${numberOfSharesToSell}</b> share(s) of <b>${escapeHtml(sharePurchase.machine.machineName)}</b>.</p>
          <p><b>Amount credited:</b> $${sellingPrice.toFixed(2)}</p>
        </div>`
      );
    } catch (emailError) {
      console.error('Email notification failed:', emailError);
    }

    return res.status(StatusCodes.OK).json({
      success: true,
      message: 'Shares sold successfully',
      data: {
        sale: {
          originalValue,
          deduction,
          sellingPrice,
          soldShares: numberOfSharesToSell,
          remainingShares: sharePurchase.numberOfShares,
          machineDetails: {
            name: sharePurchase.machine.machineName,
            id: sharePurchase.machine._id
          }
        },
        transaction: saleTransaction[0],
        newBalance: {
          total: balance.totalBalance,
          main: balance.adminAdd,
          mining: balance.miningBalance
        }
      }
    });

  } catch (error) {
    await session.abortTransaction();
    console.error('Share sale error:', error);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      success: false,
      message: 'Error processing share sale'
    });
  } finally {
    session.endSession();
  }
};