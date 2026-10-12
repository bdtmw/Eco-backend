import asyncHandler from "express-async-handler";
import User from "../model/UserModel.js";
import generateToken from "../helper/generateToken.js";
import bcrypt from "bcryptjs";
import nodemailer from 'nodemailer';
import dotenv from 'dotenv';
import ejs from 'ejs';
import { fileURLToPath } from 'url';
import path from 'path';
import { sendEmail } from "../helper/emailServer.js";
import crypto from "crypto";
import mongoose from "mongoose";

// Load environment variables
dotenv.config();
const __filename = fileURLToPath(import.meta.url);

const isStr = (v) => typeof v === "string";
const generateOtp = () => crypto.randomInt(100000, 1000000).toString();
const hashToken = (t) => crypto.createHash("sha256").update(t).digest("hex");
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};


export const registerUser = asyncHandler(async (req, res) => {
  const { firstName, lastName, email, password, country, phoneNumber, referralCode } = req.body;

  if (![firstName, lastName, email, password, country, phoneNumber].every(isStr) ||
      !firstName || !lastName || !email || !password || !country || !phoneNumber)
    return res.status(400).json({ message: "All fields are required" });

  if (password.length < 6)
    return res.status(400).json({ message: "Password must be at least 6 characters long" });

  const normalizedEmail = email.trim().toLowerCase();
  const userExists = await User.findOne({ email: normalizedEmail });
  if (userExists) return res.status(400).json({ message: "User already exists" });

  let referrer = null;
  if (referralCode) {
    if (!isStr(referralCode)) return res.status(400).json({ message: "Invalid referral code" });
    referrer = await User.findOne({ referralCode });
    if (!referrer) return res.status(400).json({ message: "Invalid referral code" });
  }

  const newReferralCode = `${firstName.toLowerCase()}-${Math.random().toString(36).substring(2, 8)}`;

  const user = await User.create({
    firstName,
    lastName,
    email: normalizedEmail,
    password,
    country,
    phoneNumber,
    referralId: referrer?._id || null,
    referralCode: newReferralCode,
    isVerified: false, // 🚨 user is unverified at registration
  });

  // Generate OTP
  const otp = generateOtp();
  user.otpCode = otp;
  user.otpExpires = new Date(Date.now() + 5 * 60 * 1000);
  await user.save();

await sendEmail(
  user.email,
  "Your Verification OTP",
  otp            // <-- just the code, no HTML
);


  res.status(200).json({
    message: "OTP sent to your email. Please verify to complete registration.",
    email: user.email,
  });
});


export const verifyOtp = asyncHandler(async (req, res) => {
  const { email, otp } = req.body;
  if (!isStr(email) || !isStr(otp))
    return res.status(400).json({ message: "Email and OTP are required" });

  const user = await User.findOne({ email: email.trim().toLowerCase() });
  if (!user) return res.status(400).json({ message: "Invalid OTP" });
  if (user.isVerified) return res.status(400).json({ message: "Email already verified" });

  if (!user.otpCode || !safeEqual(user.otpCode, otp))
    return res.status(400).json({ message: "Invalid OTP" });

  if (new Date(user.otpExpires) < new Date())
    return res.status(400).json({ message: "OTP expired" });

  // ✅ Mark user verified
  user.isVerified = true;
  user.otpCode = null;
  user.otpExpires = null;

  await user.save(); // save first
  const token = generateToken(user._id);

  res.status(200).json({
    message: "Email verification successful.",
    user: {
      id:user._id,
      _id: user._id,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      role: user.role,
      phoneNumber: user.phoneNumber,
      role: user.role,
      referralCode: user.referralCode,
      referralId: user.referralId,
    },
    token,
  });
});




// Login user
export const loginUser = asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  if (!isStr(email) || !isStr(password) || !email || !password)
    return res.status(400).json({ message: "All fields are required" });

  const user = await User.findOne({ email: email.trim().toLowerCase() });
  if (!user) return res.status(400).json({ message: "Invalid email or password" });

  const isPasswordValid = await bcrypt.compare(password, user.password);
  if (!isPasswordValid)
    return res.status(400).json({ message: "Invalid email or password" });

  // Skip verification check if user is admin
  if (user.role !== "admin" && !user.isVerified)
    return res
      .status(401)
      .json({ message: "Please verify your email before login." });

  // 1) If 2FA is NOT enabled → normal login (your existing behavior)
  if (!user.twoFactorEnabled) {
    const token = generateToken(user._id);

    res.cookie("token", token, {
      httpOnly: true,
      secure: true,
      sameSite: "none",
      path: "/",
      maxAge: 24 * 60 * 60 * 1000,
    });

    return res.status(200).json({
      success: true,
      requires2FA: false,
      message: "Login successful",
      user: {
        _id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        role: user.role,
        phoneNumber: user.phoneNumber,
        referralCode: user.referralCode,
        referralId: user.referralId,
        twoFactorEnabled: user.twoFactorEnabled,
      },
      token,
    });
  }

  // 2) If 2FA is enabled → generate OTP, email it, NO token/cookie yet
  const otp = generateOtp();
  user.otpCode = otp;
  user.otpExpires = new Date(Date.now() + 5 * 60 * 1000); // 5 mins
  await user.save();

  try {
    await sendEmail(user.email, "Your Verification OTP", otp);
  } catch (emailErr) {
    console.error("2FA email send error:", emailErr);
    return res
      .status(500)
      .json({ message: "Failed to send 2FA code. Please try again." });
  }

  // Do NOT set cookie or token here
  return res.status(200).json({
    success: true,
    requires2FA: true,
    message: "2FA code sent to your email.",
    userId: user._id,
    email: user.email,
  });
});

export const resendVerificationOtp = async (req, res) => {
  try {
    const { email } = req.body;

    if (!isStr(email) || !email) {
      return res.status(400).json({ message: "Email is required" });
    }

    const user = await User.findOne({ email: email.trim().toLowerCase() });

    // Do not reveal whether the account exists
    if (!user) {
      return res.status(200).json({
        message: "If the account exists, a new verification code has been sent.",
      });
    }

    // Optional: prevent resending if already verified
    if (user.isVerified) {
      return res.status(400).json({ message: "User is already verified" });
    }

    // Generate new OTP
    const otp = generateOtp();
    user.otpCode = otp;
    user.otpExpires = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes
    await user.save();

    // Send email with OTP
    // For subject "Your Verification OTP" your sendEmail expects the 3rd arg
    // to be the OTP code (NOT full HTML).
    await sendEmail(user.email, "Your Verification OTP", otp);

    return res.status(200).json({
      message: "A new verification code has been sent to your email.",
    });
  } catch (error) {
    console.error("Resend OTP error:", error);
    return res.status(500).json({
      message: "Failed to resend verification code.",
    });
  }
};


export const verifyPassword = asyncHandler(async (req, res) => {
  const { password } = req.body;

  if (!password) {
    return res.status(400).json({ message: "Password is required" });
  }

  const user = await User.findById(req.user._id);

  if (!user) {
    return res.status(404).json({ message: "User not found" });
  }

  const isMatch = await bcrypt.compare(password, user.password);

  if (!isMatch) {
    return res.status(400).json({ message: "Invalid password" });
  }

  res.status(200).json({ message: "Password verified successfully" });
});



export const getCurrentUser = asyncHandler(async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select("-password");
    
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    res.status(200).json({
      id: user._id,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      role:user.role,
      phoneNumber:user.phoneNumber,
      country: user.country, // Include country in response
      mainBalance:user.mainBalance,
      referralCode: user.referralCode,
      referralId: user.referralId,

    });
  } catch (error) {
    console.error("Get current user error:", error);
    res.status(500).json({ message: "Server error" });
  }
});


export const logoutUser = asyncHandler(async (req, res) => {
  const cookieOptions = {
    httpOnly: true,
    secure: true, 
    sameSite: 'none', 
    path: '/',
  };
  
  res.clearCookie("token", cookieOptions);
  res.status(200).json({ message: "User logged out successfully" });
});

export const profile = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id).select("-password");

  if (!user) {
    return res.status(404).json({ message: "User not found" });
  }

  res.status(200).json({
    
    name: user.name,
    email: user.email,
    role: user.role,

  });
});


export const updateProfile = asyncHandler(async (req, res) => {
  const { firstName, lastName, country, phoneNumber } = req.body;

  try {
    const user = await User.findById(req.user._id);

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Update only the fields that are provided
    if (firstName) user.firstName = firstName;
    if (lastName) user.lastName = lastName;
    if (country) user.country = country;
    if (phoneNumber) user.phoneNumber = phoneNumber;

    // Save the updated user
    const updatedUser = await user.save();

    res.status(200).json({
      _id: updatedUser._id,
      firstName: updatedUser.firstName,
      lastName: updatedUser.lastName,
      email: updatedUser.email,
      role: updatedUser.role,
      country: updatedUser.country,
      phoneNumber: updatedUser.phoneNumber
    });
  } catch (error) {
    console.error("Update profile error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
});


export const getMyReferrals = async (req, res) => {
  try {
    const userId = req.params.userId;

    if (
      !mongoose.Types.ObjectId.isValid(userId) ||
      (String(req.user._id) !== String(userId) && req.user.role !== "admin")
    ) {
      return res.status(403).json({ message: "Not allowed" });
    }

    let referrals = await User.find({ referralId: userId })
      .select("firstName lastName email createdAt deposit_count discount referralStatus");

    // Format discount to always show 2 decimals (0.40)
    referrals = referrals.map(ref => ({
      ...ref.toObject(),
      discount: ref.discount ? ref.discount.toFixed(2) : "0.00"
    }));

    return res.status(200).json({
      success: true,
      total: referrals.length,
      users: referrals,
    });

  } catch (error) {
    return res.status(500).json({ message: "Error fetching referrals" });
  }
};



export const updatePassword = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;

  if (!isStr(currentPassword) || !isStr(newPassword) || !currentPassword || !newPassword)
    return res.status(400).json({ message: "All fields are required" });

  if (newPassword.length < 6)
    return res.status(400).json({ message: "Password must be at least 6 characters long" });

  const user = await User.findById(req.user._id);
  if (!user) return res.status(404).json({ message: "User not found" });

  const valid = await bcrypt.compare(currentPassword, user.password);
  if (!valid)
    return res.status(400).json({ message: "Current password is incorrect" });

  // Hashed by the User model's pre-save hook
  user.password = newPassword;
  await user.save();

  return res.status(200).json({ message: "Password updated successfully" });
});

export const forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;
    const genericResponse = {
      message: "If an account exists for that email, a reset link has been sent.",
    };

    if (!isStr(email) || !email) {
      return res.status(400).json({ message: "Email is required" });
    }

    const user = await User.findOne({ email: email.trim().toLowerCase() });
    if (!user) return res.status(200).json(genericResponse);

    // Create raw token (emailed) and store only its hash
    const resetToken = crypto.randomBytes(32).toString("hex");

    user.resetPasswordToken = hashToken(resetToken);
    user.resetPasswordExpires = Date.now() + 10 * 60 * 1000; // 10 mins
    await user.save();

    // Reset link
    const resetURL = `https://ecominex.net/auth/reset-password/${resetToken}`;

 const emailData = {
      userName: `${user.firstName || ""} ${user.lastName || ""}`.trim(),
      resetURL,
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
              Reset Your Password
            </h2>

            <p style="margin:0 0 10px 0;font-size:14px;color:#d1d5db;">
              Hi ${emailData.userName || "there"},
            </p>
            <p style="margin:0 0 18px 0;font-size:14px;color:#9ca3af;line-height:1.6;">
              We received a request to reset the password for your Eco Mining account.
              Click the button below to choose a new password.
            </p>

            <!-- Button -->
            <div style="margin:0 0 18px 0;text-align:center;">
              <a href="${emailData.resetURL}"
                style="
                  display:inline-block;
                  padding:10px 22px;
                  border-radius:999px;
                  background:#22c55e;
                  color:#050810;
                  font-size:14px;
                  font-weight:600;
                  text-decoration:none;
                ">
                Reset Password
              </a>
            </div>

            <p style="margin:0 0 10px 0;font-size:12px;color:#9ca3af;line-height:1.6;">
              Or copy and paste this link into your browser:
            </p>
            <p style="margin:0 0 18px 0;font-size:11px;color:#6b7280;word-break:break-all;">
              ${emailData.resetURL}
            </p>

            <p style="margin:0 0 4px 0;font-size:12px;color:#6b7280;">
              This link will expire in 10 minutes. If you did not request a password reset,
              you can safely ignore this email.
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
      "Password Reset", // not "Password Reset Request", so it uses generic HTML branch
      html
    );

    res.json(genericResponse);
  } catch (error) {
    console.log("❌ Forgot password error:", error);
    res.status(500).json({ message: "Server error" });
  }
};


export const resetPassword = async (req, res) => {
  try {
    // token comes from URL: /reset-password/:token
    const { token } = req.params;
    // password comes from body: { password: "..." }
    const { password } = req.body;

    if (!isStr(password) || !password) {
      return res.status(400).json({ message: "Password is required" });
    }
    if (password.length < 6) {
      return res.status(400).json({ message: "Password must be at least 6 characters long" });
    }

    const user = await User.findOne({
      resetPasswordToken: hashToken(String(token)),
      resetPasswordExpires: { $gt: Date.now() }, // token not expired
    });

    if (!user) {
      return res.status(400).json({ message: "Invalid or expired token" });
    }

    // Set new password (assuming your User model hashes on save)
    user.password = password;

    // Clear reset token
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;
    user.otpCode = null;
    user.otpExpires = null;

    await user.save();

    return res.json({ message: "Password reset successful" });
  } catch (error) {
    console.log("❌ Reset password error:", error);
    return res.status(500).json({ message: "Server error" });
  }
};

// controllers/authController.js
export const toggleTwoFactor = asyncHandler(async (req, res) => {
  const { enabled } = req.body;

  const user = await User.findByIdAndUpdate(
    req.user._id,
    { twoFactorEnabled: enabled === true || enabled === "true" },
    { new: true }
  ).select("-password");

  if (!user) {
    return res.status(404).json({ success: false, message: "User not found" });
  }

  return res.json({
    success: true,
    message: `Two-factor authentication ${user.twoFactorEnabled ? "enabled" : "disabled"}.`,
  });
});

export const verifyLoginOtp = asyncHandler(async (req, res) => {
  const { userId, otp } = req.body;

  if (!isStr(userId) || !isStr(otp) || !userId || !otp || !mongoose.Types.ObjectId.isValid(userId))
    return res.status(400).json({ message: "User ID and OTP are required" });

  const user = await User.findById(userId);
  if (!user || !user.twoFactorEnabled)
    return res.status(400).json({ message: "Invalid request" });

  if (!user.otpCode || !user.otpExpires)
    return res
      .status(400)
      .json({ message: "No active OTP. Please login again." });

  if (!safeEqual(user.otpCode, otp))
    return res.status(400).json({ message: "Invalid OTP" });

  if (user.otpExpires < new Date())
    return res
      .status(400)
      .json({ message: "OTP has expired. Please login again." });

  user.otpCode = undefined;
  user.otpExpires = undefined;
  await user.save();

  const token = generateToken(user._id);

  res.cookie("token", token, {
    httpOnly: true,
    secure: true,
    sameSite: "none",
    path: "/",
    maxAge: 24 * 60 * 60 * 1000,
  });

  return res.status(200).json({
    success: true,
    message: "2FA verification successful",
    user: {
      _id: user._id,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      role: user.role,
      phoneNumber: user.phoneNumber,
      referralCode: user.referralCode,
      referralId: user.referralId,
      twoFactorEnabled: !!user.twoFactorEnabled, // <-- include here too
    },
    token,
  });
});


export const resendLoginOtp = asyncHandler(async (req, res) => {
  const { email } = req.body;

  if (!isStr(email) || !email) {
    return res.status(400).json({ message: "Email is required" });
  }

  const user = await User.findOne({ email: email.trim().toLowerCase() });
  const genericResponse = { message: "If 2FA is enabled, a new code has been sent." };

  if (!user || !user.twoFactorEnabled) {
    return res.json(genericResponse);
  }

  // Generate new OTP
  const otp = generateOtp();
  user.otpCode = otp;
  user.otpExpires = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes
  await user.save();

  try {
    await sendEmail(user.email, "Your Verification OTP", otp);
  } catch (err) {
    console.error("Resend login OTP email error:", err);
    return res
      .status(500)
      .json({ message: "Failed to send OTP. Please try again." });
  }

  return res.json(genericResponse);
});