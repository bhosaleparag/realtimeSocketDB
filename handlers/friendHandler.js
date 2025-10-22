const admin = require('firebase-admin');
const achievementService = require('../services/achievementService');

// Helper: Batch fetch user profiles from Firestore
const fetchUserProfiles = async (db, userIds) => {
  if (!userIds || userIds.length === 0) return {};

  try {
    // Firestore 'in' query supports max 10 items, chunk if needed
    const chunks = [];
    for (let i = 0; i < userIds.length; i += 10) {
      chunks.push(userIds.slice(i, i + 10));
    }

    const userMap = {};
    for (const chunk of chunks) {
      const usersSnapshot = await db.collection('users').where('uid', 'in', chunk).get();

      usersSnapshot.forEach(doc => {
        const userData = doc.data();
        userMap[userData.uid] = {
          uid: userData.uid,
          username: userData.username || 'Unknown',
          avatar: userData.avatar || null,
          showStats: userData.showStats ?? true,
          email: userData.email || null
        };
      });
    }

    return userMap;
  } catch (err) {
    console.error('Error fetching user profiles:', err);
    return {};
  }
};

module.exports = ({ socket, io, db, activeUsers }) => {
  const userId = socket.userId;

  // ✅ Send Friend Request
  socket.on('send-friend-request', async ({ targetUserId }) => {
    try {
      if (!targetUserId || targetUserId === userId) return;

      await db.collection('userFriends').doc(userId).set({
        [targetUserId]: { 
          senderId: userId, 
          status: 'pending', 
          addedAt: admin.firestore.FieldValue.serverTimestamp() 
        }
      }, { merge: true });

      await db.collection('userFriends').doc(targetUserId).set({
        [userId]: { 
          senderId: userId, 
          status: 'pending', 
          addedAt: admin.firestore.FieldValue.serverTimestamp() 
        }
      }, { merge: true });

      // Fetch sender's profile to send complete data
      const userProfiles = await fetchUserProfiles(db, [userId]);
      const senderProfile = userProfiles[userId] || {};

      // Notify target user with full sender info
      io.to(`user_${targetUserId}`).emit('friend-request-received', {
        from: userId,
        username: senderProfile.username || socket.username,
        avatar: senderProfile.avatar,
        showStats: senderProfile.showStats
      });

      socket.emit('friend-request-sent', { to: targetUserId });

    } catch (err) {
      console.error('Error sending friend request:', err);
      socket.emit('friend-error', { message: 'Failed to send friend request' });
    }
  });

  socket.on('accept-friend-request', async ({ targetUserId }) => {
    try {
      // Update friend statuses
      await db.collection('userFriends').doc(userId).update({ [`${targetUserId}.status`]: 'accepted' });
      await db.collection('userFriends').doc(targetUserId).update({ [`${userId}.status`]: 'accepted' });

      // Fetch acceptor's profile to send complete data
      const userProfiles = await fetchUserProfiles(db, [userId]);
      const acceptorProfile = userProfiles[userId] || {};

      io.to(`user_${targetUserId}`).emit('friend-request-accepted', {
        from: userId,
        username: acceptorProfile.username || socket.username,
        avatar: acceptorProfile.avatar,
        showStats: acceptorProfile.showStats
      });

      const targetUserPresence = activeUsers.get(targetUserId);

      socket.emit('friend-accepted', { friendId: targetUserId, presence: targetUserPresence.presence || 'offline' });

      // Update friend counts and check achievements for both users
      const [userResult, targetResult] = await Promise.all([
        achievementService.updateFriendCount(userId, admin.firestore.FieldValue.increment(1)),
        achievementService.updateFriendCount(targetUserId, admin.firestore.FieldValue.increment(1))
      ]);

      // Notify users about newly unlocked achievements
      if (userResult.achievements?.some(a => a.unlocked)) {
        socket.emit('achievements-unlocked', { achievements: userResult.achievements.filter(a => a.unlocked) });
      }

      if (targetResult.achievements?.some(a => a.unlocked)) {
        io.to(`user_${targetUserId}`).emit('achievements-unlocked', { achievements: targetResult.achievements.filter(a => a.unlocked) });
      }
      
    } catch (err) {
      console.error('Error accepting friend request:', err);
      socket.emit('friend-error', { message: 'Failed to accept request' });
    }
  });

  // ✅ Remove Friend
  socket.on('remove-friend', async ({ targetUserId }) => {
    try {
      await db.collection('userFriends').doc(userId).update({
        [targetUserId]: admin.firestore.FieldValue.delete()
      });
      
      await db.collection('userFriends').doc(targetUserId).update({
        [userId]: admin.firestore.FieldValue.delete()
      });

      io.to(`user_${targetUserId}`).emit('friend-removed', {
        by: userId
      });

      socket.emit('friend-removed', { by: targetUserId });

    } catch (err) {
      console.error('Error removing friend:', err);
      socket.emit('friend-error', { message: 'Failed to remove friend' });
    }
  });

  // ✅ Get Friend List (Enhanced with user profiles)
  socket.on('get-friends', async () => {
    try {
      const doc = await db.collection('userFriends').doc(userId).get();
      const friends = doc.exists ? doc.data() || {} : {};
      
      // Extract all friend UIDs
      const friendIds = Object.keys(friends);
      
      // Batch fetch all user profiles at once
      const userProfiles = await fetchUserProfiles(db, friendIds);

      const accepted = [];
      const pending = [];

      friendIds.forEach(fid => {
        const f = friends[fid];
        const onlineUser = activeUsers.get(fid);
        const profile = userProfiles[fid] || {};

        const friendData = {
          uid: fid,
          status: f.status, // accepted/pending
          addedAt: f.addedAt,
          senderId: f.senderId,
          presence: onlineUser ? onlineUser.presence : 'offline',
          // User profile data
          username: profile.username || 'Unknown',
          avatar: profile.avatar || null,
          showStats: profile.showStats ?? true,
          email: profile.email || null
        };
        
        if (f.status === 'accepted') {
          accepted.push(friendData);
        } else if (f.status === 'pending') {
          pending.push(friendData);
        }
      });

      socket.emit('friend-list', {
        accepted,
        pending
      });

    } catch (err) {
      console.error('Error getting friends:', err);
      socket.emit('friend-error', { message: 'Failed to get friend list' });
    }
  });

  socket.on('presence-change', async ({ presence }) => {
    try {
      const doc = await db.collection('userFriends').doc(userId).get();
      const friends = doc.exists ? doc.data() || {} : {};

      // Notify all accepted friends about presence change
      Object.keys(friends).forEach(fid => {
        if (friends[fid].status === 'accepted') {
          io.to(`user_${fid}`).emit('friend-presence-update', {
            userId: userId,
            presence: presence // 'online', 'offline', 'away', etc.
          });
        }
      });

    } catch (err) {
      console.error('Error updating presence:', err);
    }
  });
};