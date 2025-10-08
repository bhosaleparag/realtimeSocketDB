// server.js - Main Socket.IO Server
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const admin = require('firebase-admin');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
require('dotenv').config();

const { 
  redisClient, subscriberClient, 
  closeRedisConnections, checkRedisHealth, 
  isRedisAvailable 
} = require('./config/redis.config.js');
const redisService = require('./services/redisService');
const matchmakingService = require('./services/matchmakingService');
const presenceHandler = require('./handlers/presenceHandler');
const chatHandler = require('./handlers/chatHandler');
const roomHandler = require('./handlers/roomHandler');
const leaderboardHandler = require('./handlers/leaderboardHandler');
const friendHandler = require('./handlers/friendHandler');
const achievementHandler = require('./handlers/achievementHandler');
const achievementRoutes = require('./routes/achievementRoutes');
const achievementService = require('./services/achievementService');

// Initialize Express app
const app = express();
const server = http.createServer(app);

// Initialize Firebase Admin SDK
const serviceAccount = {
  "type": "service_account",
  "project_id": process.env.FIREBASE_PROJECT_ID,
  "private_key_id": "e85b67891e953125eb9ec955aedc4bc6675c76b5", //"abf65a4d1db28db8f606d36abd0ac7ebde8974f4"
  "private_key": process.env.FIREBASE_PRIVATE_KEY,
  "client_email": process.env.FIREBASE_CLIENT_EMAIL,
  "client_id": "118217008912100827596", // 117581257007229392200
  "auth_uri": "https://accounts.google.com/o/oauth2/auth",
  "token_uri": "https://oauth2.googleapis.com/token",
  "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
  "client_x509_cert_url": "https://www.googleapis.com/robot/v1/metadata/x509/firebase-adminsdk-fbsvc%40dev-battle-8b5b4.iam.gserviceaccount.com", //https://www.googleapis.com/robot/v1/metadata/x509/firebase-adminsdk-fbsvc%40dev-battle-e8b3f.iam.gserviceaccount.com
  "universe_domain": "googleapis.com"
}; 

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DATABASE_URL
});

const db = admin.firestore();

achievementService.initializeFirebase(db);

// Initialize Socket.IO with CORS
const io = socketIo(server, {
  cors: {
    origin: ["http://localhost:3000", process.env.FRONTEND_URL],
    methods: ["GET", "POST"],
    credentials: true
  },
  pingTimeout: parseInt(process.env.SOCKET_PING_TIMEOUT) || 60000,
  pingInterval: parseInt(process.env.SOCKET_PING_INTERVAL) || 25000
});

// Middleware
app.use(helmet());
app.use(compression());
app.use(cors({
  origin: ["http://localhost:3000", process.env.FRONTEND_URL],
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(morgan('combined'));
app.use('/api', achievementRoutes);
app.set('io', io);


// Store for active users and rooms
const activeUsers = new Map();
const activeRooms = new Map();
const roomUsers = new Map(); // roomId -> Set of userIds

// Redis status endpoint
app.get('/redis/status', async (req, res) => {
  try {
    const isAvailable = isRedisAvailable();
    const info = isAvailable ? await redisClient.info() : null;
    
    res.json({
      available: isAvailable,
      info: info ? info.split('\n').slice(0, 10).join('\n') : 'Redis not available'
    });
  } catch (error) {
    res.status(500).json({
      available: false,
      error: error.message
    });
  }
});

// Matchmaking stats endpoint
app.get('/matchmaking/stats', async (req, res) => {
  try {
    const stats = await matchmakingService.getQueueStatistics();
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Middleware for check user data 
io.use((socket, next) => {
  const userId = socket.handshake.auth.userId;
  const username = socket.handshake.auth.username;
  
  if (!userId || !username) {
    return next(new Error('Authentication error'));
  }
  
  socket.userId = userId;
  socket.username = username;
  next();
});

// Main connection handler
io.on('connection', async (socket) => {
  console.log(`User connected: ${socket.username} (${socket.userId})`);
  
  // Initialize user data
  const userData = {
    id: socket.userId,
    username: socket.username,
    socketId: socket.id,
    presence: 'online',
    joinedAt: new Date(),
    currentRoom: null
  };
  
  activeUsers.set(socket.userId, userData);

  // Store user session in Redis
  if (isRedisAvailable()) {
    try {
      await redisService.setPlayerSession(socket.userId, {
        username: socket.username,
        socketId: socket.id,
        presence: 'online',
        currentRoom: null
      });
    } catch (error) {
      console.error('Error setting player session in Redis:', error);
    }
  }

  // Join user's personal room for direct messaging
  socket.join(`user_${socket.userId}`);
  
  // Initialize handlers with context
  const context = { socket, io, db, activeUsers, activeRooms, roomUsers };
  
  // Register all event handlers
  presenceHandler(context);
  chatHandler(context);
  roomHandler(context);
  leaderboardHandler(context);
  friendHandler(context);
  achievementHandler(context);

  // Handle disconnection
  socket.on('disconnect', async () => {
    console.log(`User disconnected: ${socket.username} (${socket.userId})`);
    
    // Leave user's personal room
    socket.leave(`user_${socket.userId}`);
    
    // Remove from active rooms
    if (userData.currentRoom) {
      const roomUserSet = roomUsers.get(userData.currentRoom);
      if (roomUserSet) {
        roomUserSet.delete(socket.userId);
        socket.to(userData.currentRoom).emit('user-left-room', {
          userId: socket.userId,
          username: socket.username,
          roomId: userData.currentRoom
        });
      }
    }
    
    // Remove from active users
    activeUsers.delete(socket.userId);

    if (isRedisAvailable()) {
      try {
        await redisService.setPlayerSession(socket.userId, {
          username: socket.username,
          socketId: socket.id,
          presence: 'offline',
          currentRoom: null
        });
        
        // Remove from matchmaking queue if present
        await matchmakingService.removeFromQueue(socket.userId);
      } catch (error) {
        console.error('Error updating player session on disconnect:', error);
      }
    }
    
    // Broadcast updated user list
    io.emit('user-disconnected', {
      userId: socket.userId,
      username: socket.username,
      activeUsersCount: activeUsers.size
    });
  });
  
  // Send initial data to newly connected user
  socket.emit('connection-established', {
    userId: socket.userId,
    activeUsersCount: activeUsers.size,
    serverTime: new Date()
  });
  
  // Broadcast new user connection
  socket.broadcast.emit('user-connected', {
    userId: socket.userId,
    username: socket.username,
    activeUsersCount: activeUsers.size
  });
});

// Health check endpoint
app.get('/health', async (req, res) => {
  const redisHealthy = await checkRedisHealth();
  
  res.json({
    status: 'OK',
    redis: redisHealthy ? 'connected' : 'disconnected',
    firebase: 'connected',
    activeUsers: activeUsers.size,
    activeRooms: activeRooms.size,
    timestamp: new Date()
  });
});

// Get active users endpoint
app.get('/api/active-users', (req, res) => {
  const users = Array.from(activeUsers.values()).map(user => ({
    id: user.id,
    username: user.username,
    presence: user.presence,
    joinedAt: user.joinedAt
  }));
  
  res.json({ users, count: users.length });
});

// Cleanup job - runs every 10 minutes
setInterval(async () => {
  try {
    console.log('🧹 Running cleanup job...');
    
    if (isRedisAvailable()) {
      // Cleanup expired rooms
      await redisService.cleanupExpiredRooms();
      
      // Cleanup matchmaking queue
      await matchmakingService.cleanupQueue();
    }
    
    console.log('✅ Cleanup job completed');
  } catch (error) {
    console.error('Error in cleanup job:', error);
  }
}, parseInt(process.env.GAME_CLEANUP_INTERVAL) || 600000); // 10 minutes

// Graceful shutdown
const gracefulShutdown = async (signal) => {
  console.log(`\n${signal} received. Starting graceful shutdown...`);
  
  try {
    // Close server
    server.close(() => {
      console.log('✅ HTTP server closed');
    });
    
    // Close Socket.IO
    io.close(() => {
      console.log('✅ Socket.IO server closed');
    });
    
    // Close Redis connections
    await closeRedisConnections();
    
    // Close Firebase
    await admin.app().delete();
    console.log('✅ Firebase connection closed');
    
    console.log('✅ Graceful shutdown completed');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error during shutdown:', error);
    process.exit(1);
  }
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Error handlers
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});


const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`
  ╔════════════════════════════════════════════════════════╗
  ║                                                        ║
  ║   🚀 Coding Battle Server Started                      ║
  ║                                                        ║
  ║   Port: ${PORT}                                           ║
  ║   Environment: ${process.env.NODE_ENV || 'development'}                              ║
  ║   Redis: ${isRedisAvailable() ? '✅ Connected' : '❌ Disconnected'}                               ║
  ║   Firebase: ✅ Connected                               ║
  ║                                                        ║
  ║   Health Check: http://localhost:${PORT}/health           ║
  ║   Redis Status: http://localhost:${PORT}/redis/status     ║ 
  ║                                                        ║
  ╚════════════════════════════════════════════════════════╝
  `);
});

module.exports = { io, db, activeUsers, activeRooms, roomUsers };