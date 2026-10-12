import express from "express";
import { getCurrentUser, loginUser,toggleTwoFactor,verifyLoginOtp,resendLoginOtp ,logoutUser, profile,resendVerificationOtp ,registerUser , updateProfile ,verifyOtp,getMyReferrals,updatePassword,forgotPassword, resetPassword } from "../controller/userController.js";
import { adminMiddleware, creatorMiddleware, protect } from "../middleware/authMiddleware.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { deleteUser, getAllUsers, getAdminStats } from "../controller/adminContoller.js";

const route=express.Router()

const authLimiter = rateLimit({ key: "auth", max: 20 });
const otpLimiter = rateLimit({ key: "otp", max: 8 });

route.post("/register", authLimiter, registerUser);
route.post("/login", authLimiter, loginUser);
route.post("/logout", logoutUser);
route.get("/profile", protect, profile);
route.post("/verify-login-otp", otpLimiter, verifyLoginOtp);
route.post("/verify-otp", otpLimiter, verifyOtp);
route.post("/forget-password", authLimiter, forgotPassword);
route.post("/change-password", protect, authLimiter, updatePassword);
route.get("/referrals/:userId", protect, getMyReferrals);
route.post("/reset-password/:token", authLimiter, resetPassword);
route.get("/me", protect, getCurrentUser);
route.post("/resend-otp", otpLimiter, resendVerificationOtp);
route.patch("/settings/2fa", protect, toggleTwoFactor);
route.post("/resend-login-otp", otpLimiter, resendLoginOtp);

route.get("/admin/users", protect, adminMiddleware, getAllUsers);
route.get("/stats",protect,adminMiddleware ,getAdminStats);
route.delete("/admin/users/:id", protect, adminMiddleware, deleteUser);
route.put("/profile/update", protect, updateProfile); // New route for updating profile



export default route;