// handlers/roomHandler.js - Match Room Management
const admin = require('firebase-admin');

module.exports = ({ socket, io, db, activeUsers, activeRooms, roomUsers }) => {
  
  // Create new match room
  socket.on('create-room', async (data) => {
    try {
      const { roomName, roomType = 'public', maxPlayers = 5, gameSettings = {} } = data;
      const userId = socket.userId;
      const username = socket.username;
      
      // Validate input
      if (!roomName || roomName.trim().length === 0) {
        socket.emit('room-error', { message: 'Room name is required' });
        return;
      }
      
      if (roomName.length > 50) {
        socket.emit('room-error', { message: 'Room name too long (max 50 characters)' });
        return;
      }
      
      // Create room data
      const roomData = {
        id: null, // Will be set after creation
        name: roomName.trim(),
        type: roomType,
        createdBy: userId,
        creatorUsername: username,
        maxPlayers: Math.min(maxPlayers, 10), // Cap at 10 players
        currentPlayers: 1,
        participants: [userId],
        participantDetails: [{
          userId: userId,
          username: username,
          joinedAt: admin.firestore.FieldValue.serverTimestamp(),
          isReady: false,
          score: 0
        }],
        status: 'waiting', // waiting, playing, finished
        gameSettings: gameSettings,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        lastActivity: admin.firestore.FieldValue.serverTimestamp()
      };
      
      // Save to Firebase
      const docRef = await db.collection('matchRooms').add(roomData);
      roomData.id = docRef.id;
      
      // Update room data with ID
      await docRef.update({ id: docRef.id });
      
      // Join socket room
      socket.join(docRef.id);
      
      // Update user's current room
      const userData = activeUsers.get(userId);
      if (userData) {
        userData.currentRoom = docRef.id;
        activeUsers.set(userId, userData);
      }
      
      // Track room users
      roomUsers.set(docRef.id, new Set([userId]));
      
      // Store in memory
      activeRooms.set(docRef.id, {
        ...roomData,
        createdAt: new Date(),
        lastActivity: new Date()
      });
      
      // Get room data for response
      const savedDoc = await docRef.get();
      const savedData = savedDoc.data();
      
      const responseRoom = {
        ...savedData,
        createdAt: savedData.createdAt?.toDate(),
        lastActivity: savedData.lastActivity?.toDate(),
        participantDetails: savedData.participantDetails.map(p => ({
          ...p,
          joinedAt: p.joinedAt?.toDate()
        }))
      };
      
      // Notify creator
      socket.emit('room-created', {
        room: responseRoom,
        message: 'Room created successfully'
      });
      
      // Broadcast new room to all users
      io.emit('new-room-available', {
        room: responseRoom,
        createdBy: username
      });
      
    } catch (error) {
      console.error('Error creating room:', error);
      socket.emit('room-error', {
        message: 'Failed to create room'
      });
    }
  });
  
  // Join existing room
  socket.on('join-room', async (data) => {
    try {
      const { roomId } = data;
      const userId = socket.userId;
      const username = socket.username;
      
      if (!roomId) {
        socket.emit('room-error', { message: 'Room ID is required' });
        return;
      }
      
      // Get room from Firebase
      const roomRef = db.collection('matchRooms').doc(roomId);
      const roomDoc = await roomRef.get();
      
      if (!roomDoc.exists) {
        socket.emit('room-error', { message: 'Room not found' });
        return;
      }
      
      const roomData = roomDoc.data();
      
      // Check if room is full
      if (roomData.currentPlayers >= roomData.maxPlayers) {
        socket.emit('room-error', { message: 'Room is full' });
        return;
      }
      
      // Check if user is already in room
      if (roomData.participants.includes(userId)) {
        socket.emit('room-error', { message: 'You are already in this room' });
        return;
      }
      
      // Check if room is still accepting players
      if (roomData.status === 'playing') {
        socket.emit('room-error', { message: 'Game is already in progress' });
        return;
      }
      
      // Leave current room if in one
      const userData = activeUsers.get(userId);
      if (userData && userData.currentRoom) {
        socket.leave(userData.currentRoom);
        // Remove from previous room users set
        const prevRoomUsers = roomUsers.get(userData.currentRoom);
        if (prevRoomUsers) {
          prevRoomUsers.delete(userId);
        }
      }
      
      // Join socket room
      socket.join(roomId);
      
      // Update room data
      const newParticipantDetails = {
        userId: userId,
        username: username,
        joinedAt: admin.firestore.FieldValue.serverTimestamp(),
        isReady: false,
        score: 0
      };
      
      await roomRef.update({
        participants: admin.firestore.FieldValue.arrayUnion(userId),
        participantDetails: admin.firestore.FieldValue.arrayUnion(newParticipantDetails),
        currentPlayers: admin.firestore.FieldValue.increment(1),
        lastActivity: admin.firestore.FieldValue.serverTimestamp()
      });
      
      // Update user's current room
      if (userData) {
        userData.currentRoom = roomId;
        activeUsers.set(userId, userData);
      }
      
      // Track room users
      let roomUserSet = roomUsers.get(roomId);
      if (!roomUserSet) {
        roomUserSet = new Set();
        roomUsers.set(roomId, roomUserSet);
      }
      roomUserSet.add(userId);
      
      // Get updated room data
      const updatedRoomDoc = await roomRef.get();
      const updatedRoomData = updatedRoomDoc.data();
      
      // Notify user
      socket.emit('room-joined', {
        room: {
          ...updatedRoomData,
          createdAt: updatedRoomData.createdAt?.toDate(),
          lastActivity: updatedRoomData.lastActivity?.toDate(),
          participantDetails: updatedRoomData.participantDetails.map(p => ({
            ...p,
            joinedAt: p.joinedAt?.toDate()
          }))
        }
      });
      
      // Notify other room members
      socket.to(roomId).emit('user-joined-room', {
        userId: userId,
        username: username,
        roomId: roomId,
        currentPlayers: updatedRoomData.currentPlayers
      });
      
      // Broadcast room update
      io.emit('room-updated', {
        roomId: roomId,
        currentPlayers: updatedRoomData.currentPlayers,
        maxPlayers: updatedRoomData.maxPlayers
      });
      
    } catch (error) {
      console.error('Error joining room:', error);
      socket.emit('room-error', {
        message: 'Failed to join room'
      });
    }
  });
  
  // Leave room
  socket.on('leave-room', async (data) => {
    try {
      const { roomId } = data;
      const userId = socket.userId;
      const username = socket.username;
      
      if (!roomId) {
        socket.emit('room-error', { message: 'Room ID is required' });
        return;
      }
      
      // Get room from Firebase
      const roomRef = db.collection('matchRooms').doc(roomId);
      const roomDoc = await roomRef.get();
      
      if (!roomDoc.exists) {
        socket.emit('room-error', { message: 'Room not found' });
        return;
      }
      
      const roomData = roomDoc.data();
      
      // Check if user is in room
      if (!roomData.participants.includes(userId)) {
        socket.emit('room-error', { message: 'You are not in this room' });
        return;
      }
      
      // Leave socket room
      socket.leave(roomId);
      
      // Remove from room users set
      const roomUserSet = roomUsers.get(roomId);
      if (roomUserSet) {
        roomUserSet.delete(userId);
      }
      
      // Update user's current room
      const userData = activeUsers.get(userId);
      if (userData) {
        userData.currentRoom = null;
        activeUsers.set(userId, userData);
      }
      
      // Update room data
      const updatedParticipantDetails = roomData.participantDetails.filter(p => p.userId !== userId);
      
      await roomRef.update({
        participants: admin.firestore.FieldValue.arrayRemove(userId),
        participantDetails: updatedParticipantDetails,
        currentPlayers: admin.firestore.FieldValue.increment(-1),
        lastActivity: admin.firestore.FieldValue.serverTimestamp()
      });
      
      // Check if room is empty, delete it
      if (roomData.currentPlayers <= 1) {
        await roomRef.delete();
        activeRooms.delete(roomId);
        roomUsers.delete(roomId);
        
        // Broadcast room deletion
        io.emit('room-deleted', { roomId: roomId });
      } else {
        // If creator left, assign new creator
        if (roomData.createdBy === userId && updatedParticipantDetails.length > 0) {
          const newCreator = updatedParticipantDetails[0];
          await roomRef.update({
            createdBy: newCreator.userId,
            creatorUsername: newCreator.username
          });
        }
        
        // Get updated room data
        const updatedRoomDoc = await roomRef.get();
        const updatedRoomData = updatedRoomDoc.data();
        
        // Notify remaining room members
        socket.to(roomId).emit('user-left-room', {
          userId: userId,
          username: username,
          roomId: roomId,
          currentPlayers: updatedRoomData.currentPlayers
        });
        
        // Broadcast room update
        io.emit('room-updated', {
          roomId: roomId,
          currentPlayers: updatedRoomData.currentPlayers,
          maxPlayers: updatedRoomData.maxPlayers
        });
      }
      
      // Notify user
      socket.emit('room-left', {
        roomId: roomId,
        message: 'Left room successfully'
      });
      
    } catch (error) {
      console.error('Error leaving room:', error);
      socket.emit('room-error', {
        message: 'Failed to leave room'
      });
    }
  });
  
  // Get available rooms
  socket.on('get-available-rooms', async (data) => {
    try {
      const { limit = 20, roomType = 'all' } = data;
      
      let query = db.collection('matchRooms')
        .where('status', '==', 'waiting')
        .orderBy('createdAt', 'desc')
        .limit(limit);
      
      if (roomType !== 'all') {
        query = query.where('type', '==', roomType);
      }
      
      const snapshot = await query.get();
      const rooms = [];
      
      snapshot.forEach(doc => {
        const roomData = doc.data();
        rooms.push({
          id: doc.id,
          ...roomData,
          createdAt: roomData.createdAt?.toDate(),
          lastActivity: roomData.lastActivity?.toDate(),
          participantDetails: roomData.participantDetails.map(p => ({
            ...p,
            joinedAt: p.joinedAt?.toDate()
          }))
        });
      });
      
      socket.emit('available-rooms', {
        rooms: rooms,
        count: rooms.length
      });
      
    } catch (error) {
      console.error('Error getting available rooms:', error);
      socket.emit('room-error', {
        message: 'Failed to get available rooms'
      });
    }
  });
  
  // Toggle player ready status
  socket.on('toggle-ready', async (data) => {
    try {
      const { roomId } = data;
      const userId = socket.userId;
      
      if (!roomId) {
        socket.emit('room-error', { message: 'Room ID is required' });
        return;
      }
      
      const roomRef = db.collection('matchRooms').doc(roomId);
      const roomDoc = await roomRef.get();
      
      if (!roomDoc.exists) {
        socket.emit('room-error', { message: 'Room not found' });
        return;
      }
      
      const roomData = roomDoc.data();
      
      // Check if user is in room
      if (!roomData.participants.includes(userId)) {
        socket.emit('room-error', { message: 'You are not in this room' });
        return;
      }
      
      // Update participant ready status
      const updatedParticipantDetails = roomData.participantDetails.map(p => {
        if (p.userId === userId) {
          return { ...p, isReady: !p.isReady };
        }
        return p;
      });
      
      await roomRef.update({
        participantDetails: updatedParticipantDetails,
        lastActivity: admin.firestore.FieldValue.serverTimestamp()
      });
      
      const updatedParticipant = updatedParticipantDetails.find(p => p.userId === userId);
      
      // Notify room members
      io.to(roomId).emit('player-ready-status-changed', {
        userId: userId,
        username: socket.username,
        isReady: updatedParticipant.isReady,
        roomId: roomId
      });
      
      // Check if all players are ready
      const allReady = updatedParticipantDetails.every(p => p.isReady);
      const hasMinimumPlayers = updatedParticipantDetails.length >= 2;
      
      if (allReady && hasMinimumPlayers) {
        // Start game countdown
        io.to(roomId).emit('game-starting-countdown', {
          roomId: roomId,
          countdown: 5
        });
        
        // Start game after countdown
        setTimeout(async () => {
          try {
            await roomRef.update({
              status: 'playing',
              gameStartedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            
            io.to(roomId).emit('game-started', {
              roomId: roomId,
              participants: updatedParticipantDetails
            });
          } catch (error) {
            console.error('Error starting game:', error);
          }
        }, 5000);
      }
      
    } catch (error) {
      console.error('Error toggling ready status:', error);
      socket.emit('room-error', {
        message: 'Failed to update ready status'
      });
    }
  });
  
  // Broadcast game event
  socket.on('game-event', async (data) => {
    try {
      const { roomId, eventType, eventData } = data;
      const userId = socket.userId;
      const username = socket.username;
      
      if (!roomId || !eventType) {
        socket.emit('room-error', { message: 'Room ID and event type are required' });
        return;
      }
      
      // Verify user is in room
      const roomRef = db.collection('matchRooms').doc(roomId);
      const roomDoc = await roomRef.get();
      
      if (!roomDoc.exists || !roomDoc.data().participants.includes(userId)) {
        socket.emit('room-error', { message: 'You are not in this room' });
        return;
      }
      
      // Create game event
      const gameEvent = {
        userId: userId,
        username: username,
        eventType: eventType,
        eventData: eventData,
        timestamp: new Date(),
        roomId: roomId
      };
      
      // Save to Firebase
      await db.collection('gameEvents').add({
        ...gameEvent,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });
      
      // Broadcast to room
      io.to(roomId).emit('game-event-received', gameEvent);
      
      // Handle specific event types
      switch (eventType) {
        case 'bug-solved':
          // Update player score
          const roomData = roomDoc.data();
          const updatedParticipantDetails = roomData.participantDetails.map(p => {
            if (p.userId === userId) {
              return { ...p, score: p.score + (eventData.points || 10) };
            }
            return p;
          });
          
          await roomRef.update({
            participantDetails: updatedParticipantDetails,
            lastActivity: admin.firestore.FieldValue.serverTimestamp()
          });
          
          io.to(roomId).emit('score-updated', {
            userId: userId,
            username: username,
            newScore: updatedParticipantDetails.find(p => p.userId === userId).score,
            points: eventData.points || 10
          });
          break;
          
        case 'timer-update':
          io.to(roomId).emit('timer-updated', {
            timeRemaining: eventData.timeRemaining,
            totalTime: eventData.totalTime
          });
          break;
          
        case 'game-finished':
          await roomRef.update({
            status: 'finished',
            gameFinishedAt: admin.firestore.FieldValue.serverTimestamp()
          });
          
          io.to(roomId).emit('game-finished', {
            roomId: roomId,
            finalScores: roomData.participantDetails.sort((a, b) => b.score - a.score)
          });
          break;
      }
      
    } catch (error) {
      console.error('Error handling game event:', error);
      socket.emit('room-error', {
        message: 'Failed to process game event'
      });
    }
  });
  
  // Get room details
  socket.on('get-room-details', async (data) => {
    try {
      const { roomId } = data;
      
      if (!roomId) {
        socket.emit('room-error', { message: 'Room ID is required' });
        return;
      }
      
      const roomDoc = await db.collection('matchRooms').doc(roomId).get();
      
      if (!roomDoc.exists) {
        socket.emit('room-error', { message: 'Room not found' });
        return;
      }
      
      const roomData = roomDoc.data();
      
      socket.emit('room-details', {
        room: {
          ...roomData,
          createdAt: roomData.createdAt?.toDate(),
          lastActivity: roomData.lastActivity?.toDate(),
          gameStartedAt: roomData.gameStartedAt?.toDate(),
          gameFinishedAt: roomData.gameFinishedAt?.toDate(),
          participantDetails: roomData.participantDetails.map(p => ({
            ...p,
            joinedAt: p.joinedAt?.toDate()
          }))
        }
      });
      
    } catch (error) {
      console.error('Error getting room details:', error);
      socket.emit('room-error', {
        message: 'Failed to get room details'
      });
    }
  });
};