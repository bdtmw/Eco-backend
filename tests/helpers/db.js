import mongoose from "mongoose";

let replSet;

// Uses MONGO_TEST_URI if provided (must be a replica set, e.g. an Atlas dev
// cluster or a local `mongod --replSet rs0`); otherwise starts an in-memory
// replica set via mongodb-memory-server (needs to download a mongod binary once).
export async function connectTestDb() {
  let uri = process.env.MONGO_TEST_URI;
  if (!uri) {
    const { MongoMemoryReplSet } = await import("mongodb-memory-server");
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    uri = replSet.getUri();
  } else if (!/test/i.test(uri)) {
    throw new Error("Refusing to run: MONGO_TEST_URI must contain 'test' in its name");
  }
  await mongoose.connect(uri);
}

export async function disconnectTestDb() {
  await mongoose.disconnect();
  if (replSet) await replSet.stop();
}

export async function clearDb() {
  const { collections } = mongoose.connection;
  await Promise.all(Object.values(collections).map((c) => c.deleteMany({})));
}
