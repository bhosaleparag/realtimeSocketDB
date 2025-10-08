const redisService = require('../services/redisService');
const { isRedisAvailable } = require('../config/redis.config');

module.exports = ({ socket, io }) => {
  
  // Helper function to use Redis or fallback to memory
  const useRedis = isRedisAvailable();
  
  // Send message to specific room
  socket.on('send-room-message', async (data) => {
    try {
      const { roomId, message } = data;
      const userId = socket.userId;
      const username = socket.username;
      
      // Helper function to use Redis or fallback to memory

      // Validate inputs
      if (!roomId || !message || message.trim().length === 0) {
        socket.emit('chat-error', { message: 'Room ID and message are required' });
        return;
      }
      
      if (message.length > 1000) {
        socket.emit('chat-error', { message: 'Message too long (max 1000 characters)' });
        return;
      }
      
      if (!useRedis) {
        socket.emit('chat-error', { message: 'Chat service unavailable' });
        return;
      }
      
      // Check if user is in the room
      const roomData = await redisService.getRoom(roomId);
      if (!roomData) {
        socket.emit('chat-error', { message: 'Room does not exist' });
        return;
      }
      
      if (!roomData.participants || !roomData.participants.includes(userId)) {
        socket.emit('chat-error', { message: 'You are not a member of this room' });
        return;
      }
      
      // Create message object
      const messageId = `msg_${Date.now()}_${userId}`;
      const messageData = {
        id: messageId,
        userId: userId,
        username: username,
        message: message.trim(),
        roomId: roomId,
        timestamp: Date.now(),
        edited: false
      };
      
      // Save to Redis
      await redisService.saveRoomMessage(roomId, messageData);
      
      // Broadcast to room members only
      io.to(roomId).emit('new-room-message', messageData);
      
      // Confirm to sender
      socket.emit('message-sent', {
        messageId: messageId,
        roomId: roomId,
        timestamp: messageData.timestamp
      });
      
    } catch (error) {
      console.error('Error sending room message:', error);
      socket.emit('chat-error', {
        message: 'Failed to send message'
      });
    }
  });

  // Send message to friend (private chat)
  socket.on('send-friend-message', async (data) => {
    try {
      const { friendId, message } = data;
      const userId = socket.userId;

      if (!friendId || !message || message.trim().length === 0 || message.length > 1000) {
        socket.emit('chat-error', { message: 'Invalid message data.' });
        return;
      }

      if (!useRedis) {
        socket.emit('chat-error', { message: 'Chat service unavailable' });
        return;
      }

      const conversationId = [userId, friendId].sort().join('_');
      const messageId = `msg_${Date.now()}_${userId}`;

      const messageData = {
        id: messageId,
        conversationId: conversationId,
        senderId: userId,
        receiverId: friendId,
        message: message.trim(),
        timestamp: Date.now(),
      };

      // Save to Redis
      await redisService.saveFriendMessage(conversationId, messageData);

      // Broadcast message
      socket.emit('new-friend-message', messageData);
      io.to(`user_${friendId}`).emit('new-friend-message', messageData);

    } catch (error) {
      console.error('Error sending message:', error);
      socket.emit('chat-error', { message: 'Failed to send message.' });
    }
  });

  // Get friend chat history
  socket.on('get-friend-chat-history', async (data) => {
    try {
      const { friendId, limit = 50, before } = data;
      const userId = socket.userId;

      if (!useRedis) {
        socket.emit('chat-error', { message: 'Chat service unavailable' });
        return;
      }

      const conversationId = [userId, friendId].sort().join('_');

      // Get messages from Redis
      const allMessages = await redisService.getFriendMessages(conversationId, limit, before);

      socket.emit('friend-chat-history', {
        messages: allMessages,
        hasMore: allMessages.length === limit,
      });
    } catch (error) {
      console.error('Error getting history:', error);
      socket.emit('chat-error', { message: 'Failed to load history.' });
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

      if (!useRedis) {
        socket.emit('chat-error', { message: 'Chat service unavailable' });
        return;
      }
      
      const messages = await redisService.getRoomMessages(roomId, limit, before);
      
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
      const { messageId, newMessage, chatType, roomId } = data;
      const userId = socket.userId;

      if (!messageId || !newMessage || newMessage.trim().length === 0) {
        socket.emit('chat-error', { message: 'Message ID and new message are required' });
        return;
      }
      
      if (newMessage.length > 1000) {
        socket.emit('chat-error', { message: 'Message too long (max 1000 characters)' });
        return;
      }

      if (!useRedis) {
        socket.emit('chat-error', { message: 'Chat service unavailable' });
        return;
      }
      
      let messageData;
      
      if (chatType === 'room' && roomId) {
        const messages = await redisService.getRoomMessages(roomId, 50);
        messageData = messages.find(msg => msg.id === messageId);
      } else if (chatType === 'friend' && roomId) {
        let conversationId = [userId, roomId].sort().join('_');
        const messages = await redisService.getFriendMessages(conversationId, 50);
        messageData = messages.find(msg => msg.id === messageId);
      } else {
        socket.emit('chat-error', { message: 'Invalid chat type or missing ID' });
        return;
      }
      
      if (!messageData) {
        socket.emit('chat-error', { message: 'Message not found' });
        return;
      }
      
      // Check if user owns the message
      const ownerId = chatType === 'friend' ? messageData.senderId : messageData.userId;
      if (ownerId !== userId) {
        socket.emit('chat-error', { message: 'You can only edit your own messages' });
        return;
      }
      
      // Update message
      const updatedFields = {
        message: newMessage.trim(),
        edited: true,
        editedAt: Date.now()
      };
      
      const updatedMessage = { ...messageData, ...updatedFields, chatType: chatType };
      
      if (chatType === 'room') {
        await redisService.updateRoomMessage(roomId, messageId, updatedFields);
        io.to(roomId).emit('message-edited', updatedMessage);
      } else if (chatType === 'friend') {
        let conversationId = [userId, roomId].sort().join('_');
        await redisService.updateFriendMessage(conversationId, messageId, updatedFields);
        socket.emit('message-edited', updatedMessage);
        io.to(`user_${messageData.receiverId}`).emit('message-edited', updatedMessage);
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
      const { messageId, chatType, roomId } = data;
      const userId = socket.userId;
      
      if (!messageId) {
        socket.emit('chat-error', { message: 'Message ID is required' });
        return;
      }

      if (!useRedis) {
        socket.emit('chat-error', { message: 'Chat service unavailable' });
        return;
      }
      
      let messageData;
      
      if (chatType === 'room' && roomId) {
        const messages = await redisService.getRoomMessages(roomId, 50);
        messageData = messages.find(msg => msg.id === messageId);
      } else if (chatType === 'friend' && roomId) {
        let conversationId = [userId, roomId].sort().join('_');
        const messages = await redisService.getFriendMessages(conversationId, 50);
        messageData = messages.find(msg => msg.id === messageId);
      } else {
        socket.emit('chat-error', { message: 'Invalid chat type or missing ID' });
        return;
      }
      
      if (!messageData) {
        socket.emit('chat-error', { message: 'Message not found' });
        return;
      }
      
      // Check if user owns the message
      const ownerId = chatType === 'friend' ? messageData.senderId : messageData.userId;
      if (ownerId !== userId) {
        socket.emit('chat-error', { message: 'You can only delete your own messages' });
        return;
      }
      
      // Delete message
      if (chatType === 'room') {
        await redisService.deleteRoomMessage(roomId, messageId);
        io.to(roomId).emit('message-deleted', { 
          messageId: messageId, 
          roomId: roomId,
          chatType: 'room'
        });
        socket.emit('message-deleted', { 
          messageId: messageId, 
          roomId: roomId,
          chatType: 'room'
        });
      } else if (chatType === 'friend') {
        let conversationId = [userId, roomId].sort().join('_');
        await redisService.deleteFriendMessage(conversationId, messageId);
        io.to(`user_${messageData.receiverId}`).emit('message-deleted', { 
          messageId: messageId, 
          conversationId: conversationId,
          chatType: 'friend'
        });
        socket.emit('message-deleted', { 
          messageId: messageId, 
          roomId: roomId,
          chatType: 'friend'
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
    // for friend chat roomId is friendId
    const { roomId, chatType } = data;
    const typingData = {
      userId: socket.userId,
      username: socket.username,
      timestamp: Date.now()
    };
    
    if (chatType === 'room' && roomId) {
      socket.to(roomId).emit('user-typing', { ...typingData, roomId: roomId, chatType: 'room' });
    } else if (chatType === 'friend' && roomId) {
      io.to(`user_${roomId}`).emit('user-typing', { ...typingData, friendId: socket.userId, chatType: 'friend' });
    }
  });
  
  socket.on('typing-stop', (data) => {
    // for friend chat roomId is friendId
    const { roomId, chatType } = data;
    const typingData = {
      userId: socket.userId,
      username: socket.username
    };
    
    if (chatType === 'room' && roomId) {
      socket.to(roomId).emit('user-stopped-typing', { ...typingData, roomId: roomId, chatType: 'room' });
    } else if (chatType === 'friend' && roomId) {
      io.to(`user_${roomId}`).emit('user-stopped-typing', { ...typingData, friendId: socket.userId, chatType: 'friend' });
    }
  });
};