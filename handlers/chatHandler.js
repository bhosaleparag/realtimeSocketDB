const admin = require('firebase-admin');

module.exports = ({ socket, io, db }) => {
  
  // Send message to global chat
  socket.on('send-global-message', async (data) => {
    try {
      const { message, type = 'text' } = data;
      const userId = socket.userId;
      const username = socket.username;
      
      // Validate message
      if (!message || message.trim().length === 0) {
        socket.emit('chat-error', { message: 'Message cannot be empty' });
        return;
      }
      
      if (message.length > 1000) {
        socket.emit('chat-error', { message: 'Message too long (max 1000 characters)' });
        return;
      }
      
      // Create message object
      const messageData = {
        userId: userId,
        username: username,
        message: message.trim(),
        type: type,
        chatType: 'global',
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        edited: false,
        replies: []
      };
      
      // Save to Firebase
      const docRef = await db.collection('globalChat').add(messageData);
      
      // Get the actual timestamp for broadcasting
      const savedDoc = await docRef.get();
      const savedData = savedDoc.data();

      const broadcastMessage = {
        id: docRef.id,
        userId: userId,
        username: username,
        message: message.trim(),
        type: type,
        chatType: 'global',
        timestamp: savedData.timestamp?.toDate(),
        edited: false,
        replies: []
      };
      
      // Broadcast to all users
      io.emit('new-global-message', broadcastMessage);
      
      // Confirm to sender
      socket.emit('message-sent', {
        messageId: docRef.id,
        timestamp: savedData.timestamp?.toDate()
      });
      
    } catch (error) {
      console.error('Error sending global message:', error);
      socket.emit('chat-error', {
        message: 'Failed to send message'
      });
    }
  });
  
  // Send message to specific room
  socket.on('send-room-message', async (data) => {
    try {
      const { roomId, message, type = 'text' } = data;
      const userId = socket.userId;
      const username = socket.username;
      
      // Validate inputs
      if (!roomId || !message || message.trim().length === 0) {
        socket.emit('chat-error', { message: 'Room ID and message are required' });
        return;
      }
      
      if (message.length > 1000) {
        socket.emit('chat-error', { message: 'Message too long (max 1000 characters)' });
        return;
      }
      
      // Check if user is in the room
      const roomDoc = await db.collection('matchRooms').doc(roomId).get();
      if (!roomDoc.exists) {
        socket.emit('chat-error', { message: 'Room does not exist' });
        return;
      }
      
      const roomData = roomDoc.data();
      if (!roomData.participants || !roomData.participants.includes(userId)) {
        socket.emit('chat-error', { message: 'You are not a member of this room' });
        return;
      }
      
      // Create message object
      const messageData = {
        userId: userId,
        username: username,
        message: message.trim(),
        type: type,
        roomId: roomId,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        edited: false
      };
      
      // Save to Firebase
      const docRef = await db.collection('roomChat').add(messageData);
      
      // Get the actual timestamp for broadcasting
      const savedDoc = await docRef.get();
      const savedData = savedDoc.data();
      
      const broadcastMessage = {
        id: docRef.id,
        userId: userId,
        username: username,
        message: message.trim(),
        type: type,
        roomId: roomId,
        timestamp: savedData.timestamp?.toDate(),
        edited: false
      };
      
      // Broadcast to room members only
      io.to(roomId).emit('new-room-message', broadcastMessage);
      
      // Confirm to sender
      socket.emit('message-sent', {
        messageId: docRef.id,
        roomId: roomId,
        timestamp: savedData.timestamp?.toDate()
      });
      
    } catch (error) {
      console.error('Error sending room message:', error);
      socket.emit('chat-error', {
        message: 'Failed to send message'
      });
    }
  });
  
  // Get global chat history
  socket.on('get-global-chat-history', async (data) => {
    try {
      const { limit = 50, before } = data;
      
      let query = db.collection('globalChat')
        .orderBy('timestamp', 'desc')
        .limit(limit);
      
      if (before) {
        query = query.startAfter(before);
      }
      
      const snapshot = await query.get();
      const messages = [];
      
      snapshot.forEach(doc => {
        messages.push({
          id: doc.id,
          ...doc.data(),
          timestamp: doc.data().timestamp?.toDate()
        });
      });
      
      // Return in chronological order (oldest first)
      messages.reverse();
      
      socket.emit('global-chat-history', {
        messages: messages,
        hasMore: messages.length === limit
      });
      
    } catch (error) {
      console.error('Error getting global chat history:', error);
      socket.emit('chat-error', {
        message: 'Failed to load chat history'
      });
    }
  });
  
  // Get room chat history
  socket.on('get-room-chat-history', async (data) => {
    try {
      const { roomId, limit = 50, before } = data;
      
      if (!roomId) {
        socket.emit('chat-error', { message: 'Room ID is required' });
        return;
      }
      
      let query = db.collection('roomChat')
        .where('roomId', '==', roomId)
        .orderBy('timestamp', 'desc')
        .limit(limit);
      
      if (before) {
        query = query.startAfter(before);
      }
      
      const snapshot = await query.get();
      const messages = [];
      
      snapshot.forEach(doc => {
        messages.push({
          id: doc.id,
          ...doc.data(),
          timestamp: doc.data().timestamp?.toDate()
        });
      });
      
      // Return in chronological order (oldest first)
      messages.reverse();
      
      socket.emit('room-chat-history', {
        roomId: roomId,
        messages: messages,
        hasMore: messages.length === limit
      });
      
    } catch (error) {
      console.error('Error getting room chat history:', error);
      socket.emit('chat-error', {
        message: 'Failed to load room chat history'
      });
    }
  });
  
  // Edit message
  socket.on('edit-message', async (data) => {
    try {
      const { messageId, newMessage, chatType } = data;
      const userId = socket.userId;
      
      if (!messageId || !newMessage || newMessage.trim().length === 0) {
        socket.emit('chat-error', { message: 'Message ID and new message are required' });
        return;
      }
      
      if (newMessage.length > 1000) {
        socket.emit('chat-error', { message: 'Message too long (max 1000 characters)' });
        return;
      }
      
      const collection = chatType === 'global' ? 'globalChat' : 'roomChat';
      const messageRef = db.collection(collection).doc(messageId);
      const messageDoc = await messageRef.get();
      
      if (!messageDoc.exists) {
        socket.emit('chat-error', { message: 'Message not found' });
        return;
      }
      
      const messageData = messageDoc.data();
      
      // Check if user owns the message
      if (messageData.userId !== userId) {
        socket.emit('chat-error', { message: 'You can only edit your own messages' });
        return;
      }
      
      // Check if message is not too old (e.g., within 1 hour)
      const messageTime = messageData.timestamp?.toDate();
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      
      if (messageTime && messageTime < oneHourAgo) {
        socket.emit('chat-error', { message: 'Message is too old to edit' });
        return;
      }
      
      // Update message
      await messageRef.update({
        message: newMessage.trim(),
        edited: true,
        editedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      
      const updatedMessage = {
        id: messageId,
        ...messageData,
        message: newMessage.trim(),
        edited: true,
        editedAt: new Date(),
        timestamp: messageTime
      };
      
      // Broadcast edit
      if (chatType === 'global') {
        io.emit('message-edited', updatedMessage);
      } else {
        io.to(messageData.roomId).emit('message-edited', updatedMessage);
      }
      
      socket.emit('edit-success', { messageId: messageId });
      
    } catch (error) {
      console.error('Error editing message:', error);
      socket.emit('chat-error', {
        message: 'Failed to edit message'
      });
    }
  });
  
  // Delete message
  socket.on('delete-message', async (data) => {
    try {
      const { messageId, chatType } = data;
      const userId = socket.userId;
      
      if (!messageId) {
        socket.emit('chat-error', { message: 'Message ID is required' });
        return;
      }
      
      const collection = chatType === 'global' ? 'globalChat' : 'roomChat';
      const messageRef = db.collection(collection).doc(messageId);
      const messageDoc = await messageRef.get();
      
      if (!messageDoc.exists) {
        socket.emit('chat-error', { message: 'Message not found' });
        return;
      }
      
      const messageData = messageDoc.data();
      
      // Check if user owns the message (or is admin - implement as needed)
      if (messageData.userId !== userId) {
        socket.emit('chat-error', { message: 'You can only delete your own messages' });
        return;
      }
      
      // Delete message
      await messageRef.delete();
      
      // Broadcast deletion
      if (chatType === 'global') {
        io.emit('message-deleted', { messageId: messageId, chatType: 'global' });
      } else {
        io.to(messageData.roomId).emit('message-deleted', { 
          messageId: messageId, 
          roomId: messageData.roomId,
          chatType: 'room'
        });
      }
      
      socket.emit('delete-success', { messageId: messageId });
      
    } catch (error) {
      console.error('Error deleting message:', error);
      socket.emit('chat-error', {
        message: 'Failed to delete message'
      });
    }
  });
  
  // Typing indicator
  socket.on('typing-start', (data) => {
    const { roomId, chatType } = data;
    const typingData = {
      userId: socket.userId,
      username: socket.username,
      timestamp: new Date()
    };
    
    if (chatType === 'global') {
      socket.broadcast.emit('user-typing', { ...typingData, chatType: 'global' });
    } else if (roomId) {
      socket.to(roomId).emit('user-typing', { ...typingData, roomId: roomId, chatType: 'room' });
    }
  });
  
  socket.on('typing-stop', (data) => {
    const { roomId, chatType } = data;
    const typingData = {
      userId: socket.userId,
      username: socket.username
    };
    
    if (chatType === 'global') {
      socket.broadcast.emit('user-stopped-typing', { ...typingData, chatType: 'global' });
    } else if (roomId) {
      socket.to(roomId).emit('user-stopped-typing', { ...typingData, roomId: roomId, chatType: 'room' });
    }
  });
};