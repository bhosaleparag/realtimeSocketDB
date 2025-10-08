const admin = require('firebase-admin');
const achievementService = require('../services/achievementService');

module.exports = ({ socket, io, db, activeUsers }) => {
  const userId = socket.userId;

  // ✅ Send Friend Request
  socket.on('send-friend-request', async ({ targetUserId }) => {
    try {
      if (!targetUserId || targetUserId === userId) return;

      await db.collection('userFriends').doc(userId).set({
        [targetUserId]: { senderId: userId, status: 'pending', addedAt: admin.firestore.FieldValue.serverTimestamp() }
      }, { merge: true });

      await db.collection('userFriends').doc(targetUserId).set({
        [userId]: { senderId: userId, status: 'pending', addedAt: admin.firestore.FieldValue.serverTimestamp() }
      }, { merge: true });

      // Notify target user
      console.log(`user_${targetUserId}`)
      io.to(`user_${targetUserId}`).emit('friend-request-received', {
        from: userId,
        username: socket.username
      });

      socket.emit('friend-request-sent', { to: targetUserId });

    } catch (err) {
      console.error('Error sending friend request:', err);
      socket.emit('friend-error', { message: 'Failed to send friend request' });
    }
  });

  // ✅ Accept Friend Request
  socket.on('accept-friend-request', async ({ targetUserId }) => {
    try {
      await db.collection('userFriends').doc(userId).update({
        [targetUserId]: {status: 'accepted'}
      });
      await db.collection('userFriends').doc(targetUserId).update({
        [userId]: {status: 'accepted'}
      });

      // Notify both users
      io.to(`user_${targetUserId}`).emit('friend-request-accepted', {
        from: userId,
        username: socket.username
      });

      socket.emit('friend-accepted', { friendId: targetUserId });

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

      socket.emit('friend-remove', { friendId: targetUserId });

    } catch (err) {
      console.error('Error removing friend:', err);
      socket.emit('friend-error', { message: 'Failed to remove friend' });
    }
  });

  // ✅ Get Friend List
  socket.on('get-friends', async () => {
    try {
      const doc = await db.collection('userFriends').doc(userId).get();
      const friends = doc.exists ? doc.data() || {} : {};
      const accepted = [];
      const pending = [];

      Object.keys(friends).forEach(fid => {
        const f = friends[fid];
        const onlineUser = activeUsers.get(fid);
        const friendData = {
          uid: fid,
          status: f.status, // accepted/pending
          addedAt: f.addedAt,
          senderId: f.senderId,
          presence: onlineUser ? onlineUser.presence : 'offline'
        };
        
        if (f.status === 'accepted') {
          accepted.push(friendData);
        } else if (f.status === 'pending') {
          pending.push(friendData);
        }
      });
      
      const result = await achievementService.updateFriendCount(socket.userId, accepted.length);
      if (result.success && result.achievements.length > 0) {
        const unlocked = result.achievements.filter(a => a.unlocked);
        if (unlocked.length > 0) {
          socket.emit('achievements-unlocked-batch', {
            achievements: unlocked.map(a => a.achievement),
            count: unlocked.length
          });
        }
      }

      socket.emit('friend-list', {
        accepted,
        pending
      });

    } catch (err) {
      console.error('Error getting friends:', err);
      socket.emit('friend-error', { message: 'Failed to get friend list' });
    }
  });
};
