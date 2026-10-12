// profitController.js
import UserMachine from '../../model/UserMAchine.js';
import Balance from '../../model/Balance.js';
import mongoose from 'mongoose';
import { sendEmail } from '../../helper/emailServer.js';
import { isSelfOrAdmin, isValidId } from '../../utils/access.js';

export const getProfitUpdateStatus = async (req, res) => {
  try {
    const { userMachineId } = req.params;
    if (!isValidId(userMachineId)) {
      return res.status(400).json({ message: 'Invalid id' });
    }

    const userMachine = await UserMachine.findById(userMachineId)
      .populate('machine')
      .populate('user', 'firstName lastName email');

    if (!userMachine || !isSelfOrAdmin(req, userMachine.user?._id)) {
      return res.status(404).json({ message: 'User machine assignment not found' });
    }

    const lastUpdate = userMachine.lastProfitUpdate || userMachine.assignedDate;
    const currentDate = new Date();
    const hoursSinceUpdate = Math.floor((currentDate - lastUpdate) / (1000 * 60 * 60 * 24));

    res.status(200).json({
      userMachineId: userMachine._id,
      userName: `${userMachine.user.firstName} ${userMachine.user.lastName}`,
      machineName: userMachine.machine.machineName,
      lastUpdateDate: lastUpdate,
      hoursSinceLastUpdate: hoursSinceUpdate,
      hoursUntilNextUpdate: Math.max(0, 30 - hoursSinceUpdate),
      currentAccumulatedProfit: userMachine.monthlyProfitAccumulated,
      status: userMachine.status
    });
  } catch (error) {
    console.error('Error getting profit update status:', error);
    res.status(500).json({ message: 'Error getting profit update status' });
  }
};

export const updateMonthlyProfit = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { userMachineId } = req.params;
    
    const userMachine = await UserMachine.findById(userMachineId)
      .populate('machine')
      .populate('user')
      .session(session);

    if (!userMachine || !isSelfOrAdmin(req, userMachine.user?._id) || userMachine.status !== 'active') {
      await session.abortTransaction();
      return res.status(404).json({ message: 'User machine not found' });
    }

    // Calculate profit
    const lastUpdate = userMachine.lastProfitUpdate || userMachine.assignedDate;
    const currentDate = new Date();
    const daysSinceUpdate = Math.floor(
      (currentDate - lastUpdate) / (1000 * 60 * 60 * 24)
    );
    const monthsDue = Math.floor(daysSinceUpdate / 30);

    if (monthsDue >= 1) {
      // Same accrual rule as the scheduled job: whole 30-day periods only
      const profitToAdd = Number((userMachine.machine.monthlyProfit * monthsDue).toFixed(4));

      
      // Update machine's accumulated profit
      userMachine.monthlyProfitAccumulated += profitToAdd;
      userMachine.lastProfitUpdate = new Date(
        lastUpdate.getTime() + monthsDue * 30 * 24 * 60 * 60 * 1000
      );

      // Update user's balance
      const balance = await Balance.findOne({ user: userMachine.user._id }).session(session);
      if (!balance) {
        await session.abortTransaction();
        return res.status(404).json({ message: 'Balance record not found' });
      }

      // Add profit to mining balance
      balance.miningBalance += profitToAdd;
      balance.totalBalance = balance.adminAdd + balance.miningBalance;
      balance.lastUpdated = currentDate;

      // Save all changes
      await userMachine.save({ session });
      await balance.save({ session });
      await session.commitTransaction();

      return res.status(200).json({
        message: 'Profit updated successfully',
        profitAdded: profitToAdd,
        newMachineTotal: userMachine.monthlyProfitAccumulated,
        newBalance: {
          total: balance.totalBalance,
          mining: balance.miningBalance,
          adminAdd: balance.adminAdd
        }
      });
    } else {
      await session.abortTransaction();
      return res.status(200).json({
        message: 'Too soon for next update',
        daysUntilNextUpdate: 30 - daysSinceUpdate,
        nextUpdateDate: new Date(lastUpdate.getTime() + (30 * 24 * 60 * 60 * 1000))      });
    }
  } catch (error) {
    await session.abortTransaction();
    console.error('Profit update error:', error);
    return res.status(500).json({ message: 'Error updating profit' });
  } finally {
    session.endSession();
  }
};

export const manualProfitUpdate = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { userMachineId } = req.params;
    const { profitAmount } = req.body;

    if (!isValidId(userMachineId) || !Number.isFinite(Number(profitAmount)) || Number(profitAmount) === 0) {
      await session.abortTransaction();
      return res.status(400).json({ message: 'Valid profit amount is required' });
    }

    const userMachine = await UserMachine.findById(userMachineId).session(session);

    if (!userMachine) {
      await session.abortTransaction();
      return res.status(404).json({ message: 'User machine assignment not found' });
    }

    userMachine.monthlyProfitAccumulated += Number(profitAmount);
    userMachine.lastProfitUpdate = new Date();

    await userMachine.save({ session });
    await session.commitTransaction();

    res.status(200).json({
      message: 'Profit manually updated successfully',
      profitAdded: profitAmount,
      newTotal: userMachine.monthlyProfitAccumulated
    });
  } catch (error) {
    await session.abortTransaction();
    console.error('Error in manual profit update:', error);
    res.status(500).json({ message: 'Error updating profit manually' });
  } finally {
    session.endSession();
  }
};

// Add to profitController.js
export const getMachineProfitPercentages = async (req, res) => {
  try {
    const { userId } = req.params;

    if (!isValidId(userId) || !isSelfOrAdmin(req, userId)) {
      return res.status(403).json({ message: 'Not allowed' });
    }
    
    // Get all active machines for the user with their accumulated profits
    const userMachines = await UserMachine.find({
      user: userId,
      status: 'active'
    }).populate('machine', 'machineName monthlyProfit');

    if (!userMachines || userMachines.length === 0) {
      return res.status(200).json({
        machines: [],
        totalProfit: 0
      });
    }

    // Calculate total profit across all machines
    const totalProfit = userMachines.reduce((sum, machine) => 
      sum + machine.monthlyProfitAccumulated, 0);

    // Calculate percentage for each machine
    const machinePercentages = userMachines.map(machine => ({
      machineId: machine._id,
      machineName: machine.machineName,
      profit: machine.monthlyProfitAccumulated,
      percentage: totalProfit > 0 
        ? ((machine.monthlyProfitAccumulated / totalProfit) * 100).toFixed(2)
        : 0,
      monthlyProfitRate: machine.monthlyProfit,
      lastUpdate: machine.lastProfitUpdate || machine.assignedDate
    }));

    res.status(200).json({
      machines: machinePercentages,
      totalProfit: totalProfit,
      machineCount: userMachines.length,
      timestamp: new Date()
    });

  } catch (error) {
    console.error('Error calculating profit percentages:', error);
    res.status(500).json({ message: 'Error calculating profit percentages' });
  }
};