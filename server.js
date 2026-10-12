import app, { allowedOrigins } from "./app.js";
import connect from "./config.js";
import { setupAutoProfitUpdates } from "./cronJobs.js";

const port = process.env.PORT || 8000;

const server = async () => {
  try {
    await connect();
    setupAutoProfitUpdates();
    app.listen(port, () => {
      console.log(`Server is running on port ${port}`);
      console.log("Allowed origins:", allowedOrigins);
    });
  } catch (error) {
    console.error("Failed to start server:", error.message);
    process.exit(1);
  }
};
server();
