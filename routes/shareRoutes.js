import express from 'express';
import {
  getSpecialShareMachine,
  purchaseSpecialShares,
  updateAllShareProfits,
  getUserShareDetails,
  sellSharePurchase // Add the new function
} from '../controller/shareMachineController.js';
import { protect, adminMiddleware } from "../middleware/authMiddleware.js";

const router = express.Router();

// Public routes
router.get('/special-machine', getSpecialShareMachine);

// Protected routes
router.post('/purchase', protect, purchaseSpecialShares);
router.get('/user-shares/:userId', protect, getUserShareDetails);
router.post('/sell/:sharePurchaseId', protect, sellSharePurchase); // Add new route for selling shares

// Admin only routes
router.post('/update-profits', protect, adminMiddleware, updateAllShareProfits);

export default router;
