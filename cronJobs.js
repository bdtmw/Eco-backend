// cronJobs.js
import cron from 'node-cron';
import UserMachine from './model/UserMAchine.js';
import SharePurchase from './model/SharePurchase.js';
import Balance from './model/Balance.js';
import Transaction from './model/withdrawals.js';
import mongoose from 'mongoose';

// ✅ Extract the logic into a reusable function
export const runProfitUpdate = async () => {
  const now = new Date();
  console.log(`\n[PROFIT JOB] ${now.toISOString()} - Starting`);

  let normalProcessed = 0;
  let normalSkipped = 0;
  let sharesProcessed = 0;
  let sharesSkipped = 0;
  let totalPaidOut = 0;
  const errors = [];

  // ============ NORMAL MACHINES ============
  const userMachines = await UserMachine.find({ status: 'active' })
    .populate('machine')
    .populate('user');

  console.log(`[PROFIT JOB] Found ${userMachines.length} active normal machines`);

  for (const machine of userMachines) {
    // Process each machine in its OWN transaction
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        if (!machine.user?._id) return;
        if (!machine.machine?.monthlyProfit) return;

        // Re-read inside the transaction so overlapping runs cannot pay twice
        const fresh = await UserMachine.findById(machine._id).session(session);
        if (!fresh || fresh.status !== 'active') return;

        const lastUpdate = fresh.lastProfitUpdate || fresh.assignedDate;
        const currentDate = new Date();
        const lastUpdateTime = new Date(lastUpdate).getTime();

        if (lastUpdateTime > currentDate.getTime()) {
          console.warn(`[PROFIT JOB] ⚠️ Future date for machine ${machine._id}`);
          normalSkipped++;
          return;
        }

        const daysSinceUpdate = Math.floor(
          (currentDate.getTime() - lastUpdateTime) / (1000 * 60 * 60 * 24)
        );
        const monthsDue = Math.floor(daysSinceUpdate / 30);

        if (monthsDue < 1) {
          normalSkipped++;
          console.log(`[PROFIT JOB] ⏭️ Skip machine ${machine._id} - ${daysSinceUpdate} days`);
          return;
        }

        const monthlyProfit = machine.machine.monthlyProfit;
        const profitToAdd = Number((monthlyProfit * monthsDue).toFixed(4));

        fresh.monthlyProfitAccumulated += profitToAdd;
        fresh.lastProfitUpdate = new Date(
          lastUpdateTime + monthsDue * 30 * 24 * 60 * 60 * 1000
        );
        await fresh.save({ session });

        let userBalance = await Balance.findOne({ user: machine.user._id }).session(session);
        if (!userBalance) {
          userBalance = new Balance({
            user: machine.user._id,
            miningBalance: 0,
            adminAdd: 0,
            totalBalance: 0,
          });
        }

        const oldTotal = userBalance.totalBalance || 0;
        userBalance.miningBalance = Number((userBalance.miningBalance + profitToAdd).toFixed(4));
        userBalance.totalBalance = Number((userBalance.adminAdd + userBalance.miningBalance).toFixed(4));
        userBalance.lastUpdated = currentDate;
        await userBalance.save({ session });

        await Transaction.create([{
          user: machine.user._id,
          amount: profitToAdd,
          type: 'profit',
          status: 'completed',
          balanceBefore: oldTotal,
          balanceAfter: userBalance.totalBalance,
          details: monthsDue === 1
            ? `Monthly profit from ${machine.machine.machineName}`
            : `${monthsDue} months of profit from ${machine.machine.machineName} (backfill)`,
          transactionDate: currentDate,
          metadata: {
            userMachineId: machine._id,
            machineId: machine.machine._id,
            monthsPaid: monthsDue,
          },
        }], { session });

        normalProcessed++;
        totalPaidOut += profitToAdd;
        console.log(`[PROFIT JOB] ✅ Paid $${profitToAdd} to user ${machine.user._id}`);
      });
    } catch (err) {
      console.error(`[PROFIT JOB] ❌ Machine ${machine._id} failed:`, err.message);
      errors.push({ machineId: machine._id, error: err.message });
    } finally {
      session.endSession();
    }
  }

  // ============ SHARE MACHINES ============
  const activeShares = await SharePurchase.find({ status: 'active' })
    .populate('machine')
    .populate('user');

  console.log(`[PROFIT JOB] Found ${activeShares.length} active shares`);

  for (const share of activeShares) {
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        if (!share.user?._id) return;
        if (!share.machine || !share.profitPerShare) return;

        // Re-read inside the transaction so overlapping runs cannot pay twice
        const freshShare = await SharePurchase.findById(share._id).session(session);
        if (!freshShare || freshShare.status !== 'active') return;

        const lastUpdate = freshShare.lastProfitUpdate || freshShare.purchaseDate;
        const currentDate = new Date();
        const lastUpdateTime = new Date(lastUpdate).getTime();

        if (lastUpdateTime > currentDate.getTime()) {
          console.warn(`[PROFIT JOB] ⚠️ Future date for share ${share._id}`);
          sharesSkipped++;
          return;
        }

        const daysSinceUpdate = Math.floor(
          (currentDate.getTime() - lastUpdateTime) / (1000 * 60 * 60 * 24)
        );
        const monthsDue = Math.floor(daysSinceUpdate / 30);

        if (monthsDue < 1) {
          sharesSkipped++;
          console.log(`[PROFIT JOB] ⏭️ Skip share ${share._id} - ${daysSinceUpdate} days`);
          return;
        }

        const monthlyProfit = Number((freshShare.profitPerShare * freshShare.numberOfShares).toFixed(4));
        const profitToAdd = Number((monthlyProfit * monthsDue).toFixed(4));

        freshShare.totalProfitEarned = Number((freshShare.totalProfitEarned + profitToAdd).toFixed(4));
        freshShare.lastProfitUpdate = new Date(lastUpdateTime + monthsDue * 30 * 24 * 60 * 60 * 1000);
        await freshShare.save({ session });

        let userBalance = await Balance.findOne({ user: share.user._id }).session(session);
        if (!userBalance) {
          userBalance = new Balance({
            user: share.user._id,
            miningBalance: 0,
            adminAdd: 0,
            totalBalance: 0,
          });
        }

        const oldTotal = userBalance.totalBalance || 0;
        userBalance.miningBalance = Number((userBalance.miningBalance + profitToAdd).toFixed(4));
        userBalance.totalBalance = Number((userBalance.adminAdd + userBalance.miningBalance).toFixed(4));
        userBalance.lastUpdated = currentDate;
        await userBalance.save({ session });

        await Transaction.create([{
          user: share.user._id,
          amount: profitToAdd,
          type: 'SHARE_PROFIT',
          status: 'completed',
          balanceBefore: oldTotal,
          balanceAfter: userBalance.totalBalance,
          details: `${monthsDue} month(s) profit for ${freshShare.numberOfShares} shares of ${share.machine.machineName}`,
          transactionDate: currentDate,
          metadata: {
            shareId: share._id,
            monthsPaid: monthsDue,
          },
        }], { session });

        sharesProcessed++;
        totalPaidOut += profitToAdd;
        console.log(`[PROFIT JOB] ✅ Share $${profitToAdd} to user ${share.user._id}`);
      });
    } catch (err) {
      console.error(`[PROFIT JOB] ❌ Share ${share._id} failed:`, err.message);
      errors.push({ shareId: share._id, error: err.message });
    } finally {
      session.endSession();
    }
  }

  const summary = {
    normalProcessed,
    normalSkipped,
    sharesProcessed,
    sharesSkipped,
    totalPaidOut: Number(totalPaidOut.toFixed(2)),
    errors,
    finishedAt: new Date().toISOString(),
  };

  console.log(`[PROFIT JOB] ====== SUMMARY ======`, summary);
  return summary;
};

// ✅ Only use node-cron if NOT on serverless
export const setupAutoProfitUpdates = () => {
  cron.schedule('0 0 * * *', async () => {
    try {
      await runProfitUpdate();
    } catch (err) {
      console.error('[CRON] Failed:', err);
    }
  });
  console.log('✅ [CRON] Scheduled - runs daily at 00:00');
};