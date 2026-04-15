const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

let _mongod = null;

module.exports = async function connectDB() {
  const envUri = process.env.MONGO_URI;
  const defaultUri = 'mongodb://localhost:27017/circuit_breaker';

  async function connect(uri) {
    await mongoose.connect(uri);
    console.log('MongoDB connected to', uri);
  }

  if (envUri) {
    try {
      await connect(envUri);
      return;
    } catch (err) {
      console.error('MongoDB connection error using MONGO_URI:', err.message);
    }
  }

  try {
    await connect(defaultUri);
    return;
  } catch (err) {
    console.error('Local MongoDB connection error:', err.message);
  }

  try {
    console.log('Starting in-memory MongoDB as a fallback for development...');
    _mongod = await MongoMemoryServer.create();
    const memUri = _mongod.getUri();
    await connect(memUri);
    console.log('Connected to in-memory MongoDB');
  } catch (err) {
    console.error('Failed to start in-memory MongoDB:', err.message);
  }
};

