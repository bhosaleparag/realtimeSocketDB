// server.js - Main Socket.IO Server
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const admin = require('firebase-admin');
require('dotenv').config();

// Import handlers
const presenceHandler = require('./handlers/presenceHandler');
const chatHandler = require('./handlers/chatHandler');
const roomHandler = require('./handlers/roomHandler');
const leaderboardHandler = require('./handlers/leaderboardHandler');

// Initialize Express app
const app = express();
const server = http.createServer(app);

// Initialize Firebase Admin SDK
const serviceAccount = {
  "type": "service_account",
  "project_id": process.env.FIREBASE_PROJECT_ID,
  "private_key_id": "abf65a4d1db28db8f606d36abd0ac7ebde8974f4",
  "private_key": process.env.FIREBASE_PRIVATE_KEY,
  "client_email": process.env.FIREBASE_CLIENT_EMAIL,
  "client_id": "117581257007229392200",
  "auth_uri": "https://accounts.google.com/o/oauth2/auth",
  "token_uri": "https://oauth2.googleapis.com/token",
  "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
  "client_x509_cert_url": "https://www.googleapis.com/robot/v1/metadata/x509/firebase-adminsdk-fbsvc%40dev-battle-e8b3f.iam.gserviceaccount.com",
  "universe_domain": "googleapis.com"
}; 

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DATABASE_URL
});

const db = admin.firestore();

// CORS configuration
app.use(cors({
  origin: ["http://localhost:3000", process.env.FRONTEND_URL],
  credentials: true
}));

// Initialize Socket.IO with CORS
const io = socketIo(server, {
  cors: {
    origin: ["http://localhost:3000", process.env.FRONTEND_URL],
    methods: ["GET", "POST"],
    credentials: true
  }
});

// Store for active users and rooms
const activeUsers = new Map();
const activeRooms = new Map();
const roomUsers = new Map(); // roomId -> Set of userIds

// Middleware for authentication (optional)
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
io.on('connection', (socket) => {
  console.log(`User connected: ${socket.username} (${socket.userId})`);
  
  // Initialize user data
  const userData = {
    id: socket.userId,
    username: socket.username,
    socketId: socket.id,
    status: 'online',
    joinedAt: new Date(),
    currentRoom: null
  };
  
  activeUsers.set(socket.userId, userData);
  
  // Initialize handlers with context
  const context = { socket, io, db, activeUsers, activeRooms, roomUsers };
  
  // Register all event handlers
  presenceHandler(context);
  chatHandler(context);
  roomHandler(context);
  leaderboardHandler(context);
  
  // Handle disconnection
  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.username} (${socket.userId})`);
    
    // Update user presence in Firebase
    db.collection('userPresence').doc(socket.userId).update({
      status: 'offline',
      lastSeen: admin.firestore.FieldValue.serverTimestamp()
    }).catch(console.error);
    
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
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
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
    status: user.status,
    joinedAt: user.joinedAt
  }));
  
  res.json({ users, count: users.length });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Socket.IO server running on port ${PORT}`);
  console.log(`Active users: ${activeUsers.size}`);
});

module.exports = { io, db, activeUsers, activeRooms, roomUsers };