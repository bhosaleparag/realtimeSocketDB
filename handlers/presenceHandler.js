// handlers/presenceHandler.js - User Presence Management
const admin = require('firebase-admin');

module.exports = ({ socket, io, db, activeUsers }) => {
  
  // Utility: broadcast online users to everyone
  const broadcastOnlineUsers = () => {
    const onlineUsers = Array.from(activeUsers.values())
      .filter(user => user.status === 'online')
      .map(user => ({
        id: user.id,
        username: user.username,
        status: user.status,
        joinedAt: user.joinedAt,
        lastActivity: user.lastActivity
      }));

    io.emit('online-users', onlineUsers);
  };

  // Update user presence status
  socket.on('update-presence', async (data) => {
    try {
      const { status } = data;
      const userId = socket.userId;
      
      // Update in memory
      const userData = activeUsers.get(userId);
      if (userData) {
        userData.status = status;
        userData.lastActivity = new Date();
        activeUsers.set(userId, userData);
      }
      
      // Update in Firebase
      await db.collection('userPresence').doc(userId).set({
        userId: userId,
        username: socket.username,
        status: status,
        lastActivity: admin.firestore.FieldValue.serverTimestamp(),
        socketId: socket.id
      }, { merge: true });
      
      // Broadcast presence update
      io.emit('presence-updated', {
        userId: userId,
        username: socket.username,
        status: status,
        timestamp: new Date()
      });

      // 🔥 Broadcast the full online users list
      broadcastOnlineUsers();
      
      socket.emit('presence-update-success', { status });
      
    } catch (error) {
      console.error('Error updating presence:', error);
      socket.emit('presence-error', {
        message: 'Failed to update presence status'
      });
    }
  });
  
  // Get all online users (manual request)
  socket.on('get-online-users', async () => {
    try {
      broadcastOnlineUsers(); // reuse the utility
    } catch (error) {
      console.error('Error getting online users:', error);
      socket.emit('presence-error', {
        message: 'Failed to get online users'
      });
    }
  });
  
  // Handle user going idle/away
  socket.on('user-idle', async () => {
    try {
      const userId = socket.userId;
      const userData = activeUsers.get(userId);
      
      if (userData) {
        userData.status = 'idle';
        userData.lastActivity = new Date();
        activeUsers.set(userId, userData);
      }
      
      // Update in Firebase
      await db.collection('userPresence').doc(userId).update({
        status: 'idle',
        lastActivity: admin.firestore.FieldValue.serverTimestamp()
      });
      
      io.emit('user-went-idle', {
        userId,
        username: socket.username,
        timestamp: new Date()
      });

      // 🔥 Broadcast updated list
      broadcastOnlineUsers();
      
    } catch (error) {
      console.error('Error setting user idle:', error);
    }
  });
  
  // Handle user coming back from idle
  socket.on('user-active', async () => {
    try {
      const userId = socket.userId;
      const userData = activeUsers.get(userId);
      
      if (userData) {
        userData.status = 'online';
        userData.lastActivity = new Date();
        activeUsers.set(userId, userData);
      }
      
      await db.collection('userPresence').doc(userId).update({
        status: 'online',
        lastActivity: admin.firestore.FieldValue.serverTimestamp()
      });

      io.emit('user-became-active', {
        userId,
        username: socket.username,
        timestamp: new Date()
      });

      // 🔥 Broadcast updated list
      broadcastOnlineUsers();
      
    } catch (error) {
      console.error('Error setting user active:', error);
    }
  });
  
  // Set user presence on connection
  socket.on('set-initial-presence', async () => {
    try {
      const userId = socket.userId;
      
      activeUsers.set(userId, {
        id: userId,
        username: socket.username,
        status: 'online',
        joinedAt: new Date(),
        lastActivity: new Date()
      });
      
      await db.collection('userPresence').doc(userId).set({
        userId,
        username: socket.username,
        status: 'online',
        lastActivity: admin.firestore.FieldValue.serverTimestamp(),
        socketId: socket.id,
        connectedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      
      socket.emit('initial-presence-set', {
        userId,
        status: 'online'
      });

      // 🔥 Broadcast updated list
      broadcastOnlineUsers();
      
    } catch (error) {
      console.error('Error setting initial presence:', error);
    }
  });

  // When socket disconnects
  socket.on('disconnect', () => {
    const userId = socket.userId;
    if (userId && activeUsers.has(userId)) {
      activeUsers.delete(userId);

      io.emit('user-disconnected', {
        userId,
        username: socket.username,
        timestamp: new Date()
      });

      // 🔥 Broadcast updated list
      broadcastOnlineUsers();
    }
  });
  
  // Get presence statistics
  socket.on('get-presence-stats', async () => {
    try {
      const onlineCount = Array.from(activeUsers.values())
        .filter(user => user.status === 'online').length;
      
      const idleCount = Array.from(activeUsers.values())
        .filter(user => user.status === 'idle').length;
      
      const awayCount = Array.from(activeUsers.values())
        .filter(user => user.status === 'away').length;
      
      socket.emit('presence-stats', {
        online: onlineCount,
        idle: idleCount,
        away: awayCount,
        total: activeUsers.size,
        timestamp: new Date()
      });
      
    } catch (error) {
      console.error('Error getting presence stats:', error);
      socket.emit('presence-error', {
        message: 'Failed to get presence statistics'
      });
    }
  });
};
