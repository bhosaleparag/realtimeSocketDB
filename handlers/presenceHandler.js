// handlers/presenceHandler.js - Minimal In-Memory Presence Management
module.exports = ({ socket, activeUsers }) => {
  
  // Update user presence status
  socket.on('update-presence', (data) => {
    try {
      const { status } = data;
      const userId = socket.userId;
      
      // Update in memory only
      const userData = activeUsers.get(userId);
      if (userData) {
        userData.presence = status;
        userData.lastActivity = Date.now();
        activeUsers.set(userId, userData);
      }
      
      socket.emit('presence-update-success', { status });
      
    } catch (error) {
      console.error('Error updating presence:', error);
      socket.emit('presence-error', {
        message: 'Failed to update presence status'
      });
    }
  });
  
  // Get specific user's presence
  socket.on('get-user-presence', (data) => {
    try {
      const { userId } = data;
      const userData = activeUsers.get(userId);
      
      socket.emit('user-presence', {
        userId,
        presence: userData ? userData.presence : 'offline',
        lastActivity: userData ? userData.lastActivity : null
      });
      
    } catch (error) {
      console.error('Error getting user presence:', error);
    }
  });
  
  // Get multiple users' presence (for friend lists)
  socket.on('get-users-presence', (data) => {
    try {
      const { userIds } = data;
      const presences = {};
      
      userIds.forEach(uid => {
        const userData = activeUsers.get(uid);
        presences[uid] = userData ? userData.presence : 'offline';
      });
      
      socket.emit('users-presence', presences);
      
    } catch (error) {
      console.error('Error getting users presence:', error);
    }
  });
  
  // Handle user going idle
  socket.on('user-idle', () => {
    try {
      const userId = socket.userId;
      const userData = activeUsers.get(userId);
      
      if (userData) {
        userData.presence = 'idle';
        userData.lastActivity = Date.now();
        activeUsers.set(userId, userData);
      }
      
      socket.emit('idle-confirmed', { userId });
      
    } catch (error) {
      console.error('Error setting user idle:', error);
    }
  });
  
  // Handle user coming back from idle
  socket.on('user-active', () => {
    try {
      const userId = socket.userId;
      const userData = activeUsers.get(userId);
      
      if (userData) {
        userData.presence = 'online';
        userData.lastActivity = Date.now();
        activeUsers.set(userId, userData);
      }
      
      socket.emit('active-confirmed', { userId });
      
    } catch (error) {
      console.error('Error setting user active:', error);
    }
  });
  
  // Set user presence on connection
  socket.on('set-initial-presence', () => {
    try {
      const userId = socket.userId;
      
      activeUsers.set(userId, {
        id: userId,
        username: socket.username,
        presence: 'online',
        joinedAt: Date.now(),
        lastActivity: Date.now()
      });
      
      socket.emit('initial-presence-set', {
        userId,
        presence: 'online'
      });
      
    } catch (error) {
      console.error('Error setting initial presence:', error);
    }
  });
  
  // Get presence statistics
  socket.on('get-presence-stats', () => {
    try {
      const stats = { online: 0, idle: 0, away: 0 };
      
      activeUsers.forEach(user => {
        if (stats[user.presence] !== undefined) {
          stats[user.presence]++;
        }
      });
      
      socket.emit('presence-stats', {
        ...stats,
        total: activeUsers.size,
        timestamp: Date.now()
      });
      
    } catch (error) {
      console.error('Error getting presence stats:', error);
    }
  });
};