// machineController.js
import UserMachine from '../../model/UserMAchine.js';
import MiningMachine from '../../model/MiningMachine.js';
import mongoose from 'mongoose';
import { sendEmail } from '../../helper/emailServer.js';
import User from '../../model/UserModel.js';
import { isSelfOrAdmin, isValidId, isPositiveInt, escapeHtml } from '../../utils/access.js';



export const assignMachineToUser = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { userId, machineId, quantity = 1 } = req.body;

    if (!isValidId(userId) || !isValidId(machineId) || !isPositiveInt(quantity) || quantity > 100) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: 'User ID, Machine ID, and valid quantity are required' });
    }

    const user = await User.findById(userId).session(session);
    if (!user) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ message: 'User not found' });
    }

    const machine = await MiningMachine.findById(machineId).session(session);
    if (!machine) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ message: 'Machine not found' });
    }

    const assignments = [];
    for (let i = 0; i < quantity; i++) {
      const userMachine = new UserMachine({
        user: userId,
        machine: machineId,
        assignedDate: new Date(),
        status: 'active',
        monthlyProfitAccumulated: 0,
        machineName: machine.machineName,
        hashrate: machine.hashrate,
        powerConsumption: machine.powerConsumption,
        priceRange: machine.priceRange,
        coinsMined: machine.coinsMined,
        monthlyProfit: machine.monthlyProfit,
        description: machine.description,
        images: machine.images
      });

      assignments.push(userMachine);
    }

    await UserMachine.insertMany(assignments, { session });

   const emailData = {
  userName: `${user.firstName || ""} ${user.lastName || ""}`.trim(),
  machineName: machine.machineName?.toString() || "Mining Machine",
  quantity,
  assignedDate: new Date().toLocaleDateString(),
  machinePrice: Number(machine.priceRange || 0).toFixed(2),
  monthlyProfit: Number(machine.monthlyProfit || 0).toFixed(2),
  powerConsumption: machine.powerConsumption?.toString() || "N/A",
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
          New Mining Machines Assigned
        </h2>

        <p style="margin:0 0 10px 0;font-size:14px;color:#d1d5db;">
          Hi ${escapeHtml(emailData.userName) || "there"},
        </p>
        <p style="margin:0 0 18px 0;font-size:14px;color:#9ca3af;line-height:1.6;">
          You have been assigned new mining machine(s):
          <span style="color:#f9fafb;font-weight:600;">
            ${escapeHtml(emailData.machineName)}
          </span>.
          Your mining capacity has been updated in your dashboard.
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
            <span style="color:#e5e7eb;font-weight:600;">Machine:</span>
            <span style="float:right;color:#f9fafb;font-weight:600;">
              ${escapeHtml(emailData.machineName)}
            </span>
          </p>
          <p style="margin:0 0 6px 0;font-size:13px;color:#9ca3af;clear:both;">
            <span style="color:#e5e7eb;font-weight:600;">Quantity:</span>
            <span style="float:right;color:#f9fafb;">
              ${emailData.quantity}
            </span>
          </p>
          <p style="margin:0 0 6px 0;font-size:13px;color:#9ca3af;clear:both;">
            <span style="color:#e5e7eb;font-weight:600;">Assigned On:</span>
            <span style="float:right;color:#f9fafb;">
              ${emailData.assignedDate}
            </span>
          </p>
          <p style="margin:0 0 6px 0;font-size:13px;color:#9ca3af;clear:both;">
            <span style="color:#e5e7eb;font-weight:600;">Price per Machine:</span>
            <span style="float:right;color:#f9fafb;">
              $${emailData.machinePrice}
            </span>
          </p>
          <p style="margin:0 0 6px 0;font-size:13px;color:#9ca3af;clear:both;">
            <span style="color:#e5e7eb;font-weight:600;">Monthly Profit (per machine):</span>
            <span style="float:right;color:#4ade80;font-weight:600;">
              $${emailData.monthlyProfit}
            </span>
          </p>
          <p style="margin:0;font-size:13px;color:#9ca3af;clear:both;">
            <span style="color:#e5e7eb;font-weight:600;">Power Consumption:</span>
            <span style="float:right;color:#f9fafb;">
              ${emailData.powerConsumption} W
            </span>
          </p>
        </div>

        <p style="margin:0 0 12px 0;font-size:13px;color:#9ca3af;line-height:1.6;">
          You can view and manage these machines in your dashboard under
          <span style="color:#e5e7eb;font-weight:500;">My Machines</span>.
        </p>

        <p style="margin:0 0 4px 0;font-size:12px;color:#6b7280;">
          If you did not authorize this assignment, please contact support immediately.
        </p>
      </div>

      <!-- Footer -->
      <p style="margin:16px 0 0 0;font-size:11px;color:#6b7280;text-align:center;">
        © ${new Date().getFullYear()} The Eco Mining. All rights reserved.
      </p>
    </div>
  </div>
`;

await sendEmail(
  user.email,
  "New Mining Machines Assigned",
  html
);
    await session.commitTransaction();

    const populatedAssignments = await UserMachine.find({
      _id: { $in: assignments.map(a => a._id) }
    })
      .populate('user', 'firstName lastName email')
      .populate('machine', 'machineName model');

    res.status(201).json(populatedAssignments);
  } catch (error) {
    await session.abortTransaction();
    console.error('Machine assignment error:', error);
    res.status(500).json({ message: 'Error assigning machines to user' });
  } finally {
    session.endSession();
  }
};

export const getUserMachines = async (req, res) => {
  try {
    const userIdentifier = req.params.userId;

    if (!userIdentifier) {
      return res.status(400).json({ message: 'User identifier is required' });
    }

    let user;
    if (isValidId(userIdentifier)) {
      user = await User.findById(userIdentifier);
    } else if (typeof userIdentifier === 'string') {
      user = await User.findOne({ email: userIdentifier.toLowerCase() });
    }

    // Same response for "missing" and "not yours" to avoid user enumeration
    if (!user || !isSelfOrAdmin(req, user._id)) {
      return res.status(404).json({ message: 'User not found' });
    }

    const userMachines = await UserMachine.find({ user: user._id })
      .populate('user', 'firstName lastName email')
      .populate('machine', 'machineName model');

    res.status(200).json(userMachines.length === 0 ? [] : userMachines);
  } catch (error) {
    console.error('Error retrieving user machines:', error);
    res.status(500).json({ message: 'Error retrieving user machines' });
  }
};

export const removeUserMachine = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { userMachineId } = req.params;

    if (!userMachineId) {
      await session.abortTransaction();
      return res.status(400).json({ message: 'User Machine ID is required' });
    }

    const removedUserMachine = await UserMachine.findByIdAndDelete(userMachineId, { session });

    if (!removedUserMachine) {
      await session.abortTransaction();
      return res.status(404).json({ message: 'User Machine assignment not found' });
    }

    await session.commitTransaction();
    res.status(200).json({ message: 'Machine assignment removed successfully', removedUserMachine });
  } catch (error) {
    await session.abortTransaction();
    console.error('Error removing user machine:', error);
    res.status(500).json({ message: 'Error removing user machine assignment', error: error.message });
  } finally {
    session.endSession();
  }
};

export const getAllUserMachines = async (req, res) => {
  try {
    const userMachines = await UserMachine.find()
      .populate('user', 'firstName lastName email')
      .populate('machine', 'machineName model');

    res.status(200).json(userMachines);
  } catch (error) {
    console.error('Error retrieving all user machines:', error);
    res.status(500).json({ message: 'Error retrieving all user machines', error: error.message });
  }
};