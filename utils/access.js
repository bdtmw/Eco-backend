import mongoose from "mongoose";

export const isValidId = (id) =>
  typeof id === "string" && mongoose.Types.ObjectId.isValid(id);

export const isAdmin = (req) => req.user?.role === "admin";

// True if the authenticated user owns the resource or is an admin.
export const isSelfOrAdmin = (req, ownerId) =>
  isAdmin(req) || String(req.user._id) === String(ownerId);

// Positive, finite number (rejects strings, NaN, Infinity, negatives, 0).
export const isPositiveNumber = (n) =>
  typeof n === "number" && Number.isFinite(n) && n > 0;

export const isPositiveInt = (n) => Number.isInteger(n) && n > 0;

export const escapeHtml = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
