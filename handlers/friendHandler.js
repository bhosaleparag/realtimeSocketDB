const admin = require('firebase-admin');

module.exports = ({ socket, io, db, activeUsers }) => {
  const userId = socket.userId;

  // ✅ Send Friend Request
  socket.on('send-friend-request', async ({ targetUserId }) => {
    try {
      if (!targetUserId || targetUserId === userId) return;

      // Add pending request in both users
      await db.collection('userFriends').doc(userId).set({
        [`friends.${targetUserId}`]: { status: 'pending', addedAt: admin.firestore.FieldValue.serverTimestamp() }
      }, { merge: true });

      await db.collection('userFriends').doc(targetUserId).set({
        [`friends.${userId}`]: { status: 'pending', addedAt: admin.firestore.FieldValue.serverTimestamp() }
      }, { merge: true });

      // Notify target user
      io.to(activeUsers.get(targetUserId)?.socketId || '').emit('friend-request-received', {
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
        [`friends.${targetUserId}.status`]: 'accepted'
      });
      await db.collection('userFriends').doc(targetUserId).update({
        [`friends.${userId}.status`]: 'accepted'
      });

      // Notify both users
      io.to(activeUsers.get(targetUserId)?.socketId || '').emit('friend-request-accepted', {
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
        [`friends.${targetUserId}`]: admin.firestore.FieldValue.delete()
      });
      await db.collection('userFriends').doc(targetUserId).update({
        [`friends.${userId}`]: admin.firestore.FieldValue.delete()
      });

      io.to(activeUsers.get(targetUserId)?.socketId || '').emit('friend-removed', {
        by: userId
      });

      socket.emit('friend-removed', { friendId: targetUserId });

    } catch (err) {
      console.error('Error removing friend:', err);
      socket.emit('friend-error', { message: 'Failed to remove friend' });
    }
  });

  // ✅ Get Friend List
  socket.on('get-friends', async () => {
    try {
      const doc = await db.collection('userFriends').doc(userId).get();
      const friends = doc.exists ? doc.data().friends || {} : {};

      const accepted = [];
      const pending = [];

      Object.keys(friends).forEach(fid => {
        const f = friends[fid];
        const onlineUser = activeUsers.get(fid);
        const friendData = {
          userId: fid,
          status: f.status, // accepted/pending
          addedAt: f.addedAt,
          presence: onlineUser ? onlineUser.status : 'offline'
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
};
