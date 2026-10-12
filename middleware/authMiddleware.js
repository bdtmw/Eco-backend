import asyncHandler from "express-async-handler";
import jwt from "jsonwebtoken";
import User from "../model/UserModel.js";

export const protect = asyncHandler(async (req, res, next) => {
  
  try {
    let token;
    // Check cookie first
    token = req.cookies.token;

    // If no cookie, check Authorization header
    if (
      !token &&
      req.headers.authorization &&
      req.headers.authorization.startsWith("Bearer")
    ) {
      token = req.headers.authorization.split(" ")[1];
    }


    if (!token) {
      return res.status(401).json({ message: "Not authorized, please login!" });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const user = await User.findById(decoded.id).select("-password -otpCode -otpExpires -resetPasswordToken -resetPasswordExpires");

    if (!user) {
      return res.status(401).json({ message: "Not authorized, token failed!" });
    }

    req.user = user;

    next();
  } catch (error) {
    console.error("Auth Error:", error.message);
    return res.status(401).json({ message: "Not authorized, token failed!" });
  }
});

export const adminMiddleware = asyncHandler(async (req, res, next) => {
  if (req.user && req.user.role === "admin") {
    next();
    return;
  }
  res.status(403).json({ message: "Only admins can do this!" });
});

export const creatorMiddleware = asyncHandler(async (req, res, next) => {
  if (
    (req.user && req.user.role === "creator") ||
    (req.user && req.user.role === "admin")
  ) {
    next();
    return;
  }
  res.status(403).json({ message: "Only creators can do this!" });
});
