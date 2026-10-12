// routes/miningMachineRoutes.js
import express from "express";
import multer from "multer";
import { protect, adminMiddleware } from "../middleware/authMiddleware.js";
import {
  createMiningMachine,
  getAllMiningMachines,
  getMiningMachineById,
  updateMiningMachine,
  deleteMiningMachine,
} from "../controller/MachineCreate.js";

const router = express.Router();
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
});

router.post("/mining-machines", protect, adminMiddleware, upload.array("images", 5), createMiningMachine);
router.get("/mining-machines", getAllMiningMachines);
router.get("/mining-machines/:id", getMiningMachineById);
router.put(
  "/mining-machines/:id",
  protect,
  adminMiddleware,
  upload.array("images", 5),
  updateMiningMachine
);
router.delete("/mining-machines/:id", protect, adminMiddleware, deleteMiningMachine);

export default router;
