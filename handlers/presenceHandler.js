// handlers/presenceHandler.js - User Presence Management
const admin = require('firebase-admin');

module.exports = ({ socket, io, db, activeUsers }) => {
  
  // Update user presence status
  socket.on('update-presence', async (data) => {
    try {
      const { status, customMessage } = data;
      const userId = socket.userId;
      
      // Update in memory
      const userData = activeUsers.get(userId);
      if (userData) {
        userData.status = status;
        userData.customMessage = customMessage;
        userData.lastActivity = new Date();
        activeUsers.set(userId, userData);
      }
      
      // Update in Firebase
      await db.collection('userPresence').doc(userId).set({
        userId: userId,
        username: socket.username,
        status: status,
        customMessage: customMessage || null,
        lastActivity: admin.firestore.FieldValue.serverTimestamp(),
        socketId: socket.id
      }, { merge: true });
      
      // Broadcast presence update
      io.emit('presence-updated', {
        userId: userId,
        username: socket.username,
        status: status,
        customMessage: customMessage,
        timestamp: new Date()
      });
      
      socket.emit('presence-update-success', {
        status: status,
        customMessage: customMessage
      });
      
    } catch (error) {
      console.error('Error updating presence:', error);
      socket.emit('presence-error', {
        message: 'Failed to update presence status'
      });
    }
  });
  
  // Get all online users
  socket.on('get-online-users', async () => {
    try {
      const onlineUsers = Array.from(activeUsers.values())
        .filter(user => user.status === 'online')
        .map(user => ({
          id: user.id,
          username: user.username,
          status: user.status,
          customMessage: user.customMessage,
          joinedAt: user.joinedAt,
          lastActivity: user.lastActivity
        }));
      
      socket.emit('online-users', {
        users: onlineUsers,
        count: onlineUsers.length,
        totalActive: activeUsers.size
      });
      
    } catch (error) {
      console.error('Error getting online users:', error);
      socket.emit('presence-error', {
        message: 'Failed to get online users'
      });
    }
  });
  
  // Get user presence history
  socket.on('get-presence-history', async (data) => {
    try {
      const { userId, limit = 50 } = data;
      
      const snapshot = await db.collection('presenceHistory')
        .where('userId', '==', userId)
        .orderBy('timestamp', 'desc')
        .limit(limit)
        .get();
      
      const history = [];
      snapshot.forEach(doc => {
        history.push({
          id: doc.id,
          ...doc.data(),
          timestamp: doc.data().timestamp?.toDate()
        });
      });
      
      socket.emit('presence-history', {
        userId: userId,
        history: history
      });
      
    } catch (error) {
      console.error('Error getting presence history:', error);
      socket.emit('presence-error', {
        message: 'Failed to get presence history'
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
      
      // Log presence change
      await db.collection('presenceHistory').add({
        userId: userId,
        username: socket.username,
        action: 'went_idle',
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });
      
      // Broadcast idle status
      io.emit('user-went-idle', {
        userId: userId,
        username: socket.username,
        timestamp: new Date()
      });
      
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
      
      // Update in Firebase
      await db.collection('userPresence').doc(userId).update({
        status: 'online',
        lastActivity: admin.firestore.FieldValue.serverTimestamp()
      });
      
      // Log presence change
      await db.collection('presenceHistory').add({
        userId: userId,
        username: socket.username,
        action: 'became_active',
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });
      
      // Broadcast active status
      io.emit('user-became-active', {
        userId: userId,
        username: socket.username,
        timestamp: new Date()
      });
      
    } catch (error) {
      console.error('Error setting user active:', error);
    }
  });
  
  // Set user presence on connection
  socket.on('set-initial-presence', async () => {
    try {
      const userId = socket.userId;
      
      // Set initial presence in Firebase
      await db.collection('userPresence').doc(userId).set({
        userId: userId,
        username: socket.username,
        status: 'online',
        lastActivity: admin.firestore.FieldValue.serverTimestamp(),
        socketId: socket.id,
        connectedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      
      // Log connection
      await db.collection('presenceHistory').add({
        userId: userId,
        username: socket.username,
        action: 'connected',
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        socketId: socket.id
      });
      
      socket.emit('initial-presence-set', {
        userId: userId,
        status: 'online'
      });
      
    } catch (error) {
      console.error('Error setting initial presence:', error);
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