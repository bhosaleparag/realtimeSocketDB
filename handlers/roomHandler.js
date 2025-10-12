// handlers/roomHandler.js - Match Room Management with Redis
const admin = require('firebase-admin');
const redisService = require('../services/redisService');
const matchmakingService = require('../services/matchmakingService');
const { isRedisAvailable } = require('../config/redis.config');
const achievementService = require('../services/achievementService');

module.exports = ({ socket, io, db, activeUsers, activeRooms, roomUsers }) => {
  
  // Helper function to use Redis or fallback to memory
  const useRedis = isRedisAvailable();
  
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
      
      // Generate unique room ID
      const roomId = `room_${Date.now()}_${userId}`;
      
      // Create room data
      const roomData = {
        id: roomId,
        name: roomName.trim(),
        type: roomType,
        createdBy: userId,
        creatorUsername: username,
        maxPlayers: Math.min(maxPlayers, 10),
        currentPlayers: 1,
        participants: [userId],
        participantDetails: [{
          userId: userId,
          username: username,
          joinedAt: Date.now(),
          isReady: false,
          score: 0
        }],
        status: 'waiting',
        gameSettings: gameSettings,
        createdAt: Date.now(),
        lastActivity: Date.now()
      };
      
      // Save to Redis (primary) and Firebase (backup)
      if (useRedis) {
        await redisService.createRoom(roomData);
      }
      
      // Join socket room
      socket.join(roomId);
      
      // Update user's current room
      const userData = activeUsers.get(userId);
      if (userData) {
        userData.currentRoom = roomId;
        activeUsers.set(userId, userData);
      }
      
      // Track room users
      roomUsers.set(roomId, new Set([userId]));
      
      // Store in memory (fallback)
      activeRooms.set(roomId, roomData);
      
      // Notify creator
      socket.emit('room-created', {
        room: roomData,
        message: 'Room created successfully'
      });
      
      // Broadcast new room to all users
      io.emit('new-room-available', {
        room: roomData,
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
      
      // Get room from Redis first, fallback to Firebase
      let roomData = null;
      
      if (useRedis) {
        roomData = await redisService.getRoom(roomId);
      }
      
      // Validate join conditions
      if (roomData.currentPlayers >= roomData.maxPlayers) {
        socket.emit('room-error', { message: 'Room is full' });
        return;
      }
      
      if (roomData.participants.includes(userId)) {
        socket.emit('room-error', { message: 'You are already in this room' });
        return;
      }
      
      if (roomData.status === 'playing') {
        socket.emit('room-error', { message: 'Game is already in progress' });
        return;
      }
      
      // Leave current room if in one
      const userData = activeUsers.get(userId);
      if (userData && userData.currentRoom) {
        socket.leave(userData.currentRoom);
        const prevRoomUsers = roomUsers.get(userData.currentRoom);
        if (prevRoomUsers) {
          prevRoomUsers.delete(userId);
        }
      }
      
      // Join socket room
      socket.join(roomId);
      
      // Update room in Redis
      if (useRedis) {
        await redisService.addPlayerToRoom(roomId, userId, username);
        roomData = await redisService.getRoom(roomId);
      }
      
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
      
      // Notify user
      socket.emit('room-joined', { room: roomData });
      
      // Notify other room members
      socket.to(roomId).emit('user-joined-room', {
        userId: userId,
        username: username,
        roomId: roomId,
        currentPlayers: roomData.currentPlayers
      });
      
      // Broadcast room update
      io.emit('room-updated', {
        roomId: roomId,
        currentPlayers: roomData.currentPlayers,
        maxPlayers: roomData.maxPlayers
      });
      
    } catch (error) {
      console.error('Error joining room:', error);
      socket.emit('room-error', {
        message: 'Failed to join room'
      });
    }
  });

  // ==================== LEAVE ROOM HANDLER ====================
  socket.on('leave-room', async (data) => {
    try {
      const { roomId } = data;
      const userId = socket.userId;
      const username = socket.username;

      if (!roomId) {
        socket.emit('room-error', { message: 'Room ID is required' });
        return;
      }

      // Fetch room data
      let roomData = null;
      if (useRedis) {
        roomData = await redisService.getRoom(roomId);
      }

      // Handle case where room doesn't exist or was already deleted
      if (!roomData) {
        socket.emit('room-left', {
          roomId: roomId,
          message: 'Room not found or already closed'
        });
        
        // Clean up user's room reference
        const userData = activeUsers.get(userId);
        if (userData) {
          userData.currentRoom = null;
          activeUsers.set(userId, userData);
        }
        return;
      }

      // Check if user is in the room
      if (!roomData.participants.includes(userId)) {
        socket.emit('room-error', { message: 'You are not in this room' });
        return;
      }

      // Leave socket room
      socket.leave(roomId);

      // Remove from room tracking
      const roomUserSet = roomUsers.get(roomId);
      if (roomUserSet) {
        roomUserSet.delete(userId);
      }

      // Update active user data
      const userData = activeUsers.get(userId);
      if (userData) {
        userData.currentRoom = null;
        activeUsers.set(userId, userData);
      }

      // Remove player from Redis room
      let roomDeleted = false;
      let remainingPlayers = [];
      
      if (useRedis) {
        const result = await redisService.removePlayerFromRoom(roomId, userId);
        roomDeleted = result.roomDeleted;
        
        // Refresh room data if not deleted
        if (!roomDeleted) {
          roomData = await redisService.getRoom(roomId);
          remainingPlayers = roomData.participantDetails;
        }
      }

      // CASE 1: Room was deleted (last player left) OR only 1 player remains
      // In multiplayer, if one player leaves, the other should win by forfeit
      if (roomDeleted || remainingPlayers.length === 1) {
        console.log(`Player left room ${roomId} - ending game (${roomDeleted ? 'room empty' : 'only 1 player left'})`);
        
        // If there's still 1 player, they win by forfeit
        if (remainingPlayers.length === 1) {
          const winner = remainingPlayers[0];
          
          // Give winner their points
          await handleGameFinished(roomId, {
            ...roomData,
            participantDetails: [
              { ...winner, score: winner.score || 50 }, // Winner gets points
              { 
                userId: userId, 
                username: username, 
                score: 0 // Leaving player gets 0
              }
            ]
          }, {
            reason: 'player-forfeit',
            triggeredBy: 'player-left',
            forfeitedBy: userId,
            winnerId: winner.userId
          });
        }
        
        // Notify the leaving player
        socket.emit('room-left', {
          roomId: roomId,
          message: 'Left room successfully',
          roomDeleted: true,
          forfeit: true
        });
        
        return;
      }

      // CASE 2: Room has 2+ players remaining (shouldn't happen in 1v1 but kept for safety)
      // Notify other players that someone left
      socket.to(roomId).emit('user-left-room', {
        userId: userId,
        username: username,
        roomId: roomId,
        currentPlayers: remainingPlayers.length
      });

      // Notify lobby about room update
      io.emit('room-updated', {
        roomId: roomId,
        currentPlayers: remainingPlayers.length,
        maxPlayers: roomData.maxPlayers
      });

      // Confirm to leaving user
      socket.emit('room-left', {
        roomId: roomId,
        message: 'Left room successfully',
        roomDeleted: false
      });

    } catch (error) {
      console.error('Error leaving room:', error);
      socket.emit('room-error', {
        message: 'Failed to leave room',
        error: error.message
      });
    }
  });

  // ==================== GAME FINISHED HELPER ====================
  async function handleGameFinished(roomId, roomData, finishContext = {}) {
    try {
      // Update room status in Redis
      if (useRedis) {
        await redisService.updateRoom(roomId, {
          status: 'finished',
          gameFinishedAt: Date.now()
        });
      }
      
      // If room is empty or has no valid participants, just clean up
      if (!roomData || !roomData.participantDetails || roomData.participantDetails.length === 0) {
        
        // Clean up room
        if (useRedis) {
          await redisService.deleteRoom(roomId);
        }
        io.emit('room-deleted', { roomId: roomId });
        return;
      }

      // Sort participants by score
      const finalScores = roomData.participantDetails
        .sort((a, b) => (b.score || 0) - (a.score || 0))
        .map((p, index) => ({
          ...p,
          rank: index + 1,
          isWinner: index === 0
        }));

      // Determine winners (handle ties)
      const highestScore = finalScores[0]?.score || 0;
      const winners = finalScores.filter(p => p.score === highestScore);

      const gameType = roomData.gameSettings?.mode || 'quiz';

      // Prepare all player results
      const playerResults = finalScores.map(participant => {
        let result = 'loss';
        if (winners.some(w => w.userId === participant.userId)) {
          result = winners.length > 1 ? 'draw' : 'win';
        }

        return {
          userId: participant.userId,
          username: participant.username,
          result: result,
          finalScore: participant.score || 0,
          rank: participant.rank,
          totalParticipants: finalScores.length,
          points: participant.score || 0
        };
      });

      // Use a single batch for ALL Firebase operations
      const batch = db.batch();

      for (const participant of finalScores) {
        const userId = participant.userId;
        const userScore = participant.score || 0;

        // Determine result for this participant
        let result = 'loss';
        if (winners.some(w => w.userId === userId)) {
          result = winners.length > 1 ? 'draw' : 'win';
        }

        // 1. GET CURRENT LEADERBOARD DATA
        const userLeaderboardRef = db.collection('leaderboard').doc(userId);
        const userDoc = await userLeaderboardRef.get();
        
        let currentLeaderboardData = {
          userId: userId,
          username: participant.username,
          totalScore: 0,
          gamesPlayed: 0,
          wins: 0, losses: 0,
          gameTypeScores: {},
          currentWinStreak: 0,
          perfectGames: 0,
        };
        
        if (userDoc.exists) {
          currentLeaderboardData = { ...currentLeaderboardData, ...userDoc.data() };
        }

        // Calculate new leaderboard values
        const newTotalScore = currentLeaderboardData.totalScore + userScore;
        const newGamesPlayed = currentLeaderboardData.gamesPlayed + 1;
        const newAverageScore = newTotalScore / newGamesPlayed;

        // Update game type scores
        const gameTypeScores = currentLeaderboardData.gameTypeScores || {};
        gameTypeScores[gameType] = {
          score: (gameTypeScores[gameType]?.score || 0) + userScore,
          gamesPlayed: (gameTypeScores[gameType]?.gamesPlayed || 0) + 1
        };

        // Update wins/losses and currentWinStreak
        let wins = currentLeaderboardData.wins || 0;
        let losses = currentLeaderboardData.losses || 0;
        let currentWinStreak = currentLeaderboardData.currentWinStreak || 0;
        
        if (result === 'win') {
          wins += 1;
          currentWinStreak += 1;
        } else if (result === 'loss') {
          losses += 1;
          currentWinStreak = 0;
        }
        
        // Update perfect game 
        let perfectGames = currentLeaderboardData.perfectGames || 0;
        if(roomData.perfectScore === userScore){
          perfectGames+=1
        }

        // Add leaderboard update to batch
        batch.set(userLeaderboardRef, {
          userId: userId,
          username: participant.username,
          totalScore: newTotalScore,
          gamesPlayed: newGamesPlayed,
          averageScore: Math.round(newAverageScore * 100) / 100,
          wins: wins, losses: losses,
          currentWinStreak: currentWinStreak,
          gameTypeScores: gameTypeScores,
          perfectGames: perfectGames,
          lastPlayed: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        // 2. GET CURRENT USER STATS
        const userRef = db.collection('users').doc(userId);
        const userSnapshot = await userRef.get();
        
        let currentUserStats = {
          battlesWon: 0, quizzesTaken: 0, streak: 0, xp: 0
        };

        if (userSnapshot.exists && userSnapshot.data().stats) {
          currentUserStats = { ...currentUserStats, ...userSnapshot.data().stats };
        }

        // Calculate streak
        let newStreak = currentUserStats.streak || 0;
        if (result === 'win') {
          newStreak += 1;
        } else if (result === 'loss') {
          newStreak = 0;
        }

        // Add user stats update to batch
        batch.set(userRef, {
          stats: {
            battlesWon: (currentUserStats.battlesWon || 0) + (result === 'win' ? 1 : 0),
            quizzesTaken: (currentUserStats.quizzesTaken || 0) + 1,
            streak: newStreak,
            xp: (currentUserStats.xp || 0) + userScore
          },
          lastPlayedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        // 3. ADD GAME RESULT TO BATCH
        const gameResultRef = db.collection('gameResults').doc();
        batch.set(gameResultRef, {
          userId: participant.userId,
          username: participant.username,
          result: result,
          roomId: roomId,
          finalScore: participant.score || 0,
          rank: participant.rank,
          gameType: gameType,
          timestamp: admin.firestore.FieldValue.serverTimestamp()
        });
      }

      await batch.commit();

      // Broadcast game finished to all players in room
      io.to(roomId).emit('game-finished', {
        roomId: roomId,
        finalScores: finalScores,
        winners: winners.map(w => w.userId),
        gameType: gameType,
        allPlayerResults: playerResults,
        finishReason: finishContext.reason || 'completed',
        timestamp: Date.now()
      });

      // ============ CHECK ACHIEVEMENTS FOR ALL PLAYERS ============
      for (const participant of finalScores) {
        const userId = participant.userId;
        
        // Get updated user stats for achievement checking
        const userLeaderboardDoc = await db.collection('leaderboard').doc(userId).get();
        
        if (userLeaderboardDoc.exists) {
          const userStats = userLeaderboardDoc.data();
          
          // Check and unlock achievements
          const achievementResult = await achievementService.checkAndUnlockAchievements(userId, userStats);
          
          if (achievementResult.success && achievementResult.newlyUnlocked.length > 0) {
            // Find player's socket
            const playerSocket = Array.from(io.sockets.sockets.values()).find(
              s => s.userId === userId
            );
            
            if (playerSocket) {
              // Notify this player of unlocked achievements
              playerSocket.emit('achievements-unlocked-batch', {
                achievements: achievementResult.newlyUnlocked,
                count: achievementResult.count,
                timestamp: new Date()
              });
            }
            
            // Broadcast to all users
            for (const achievement of achievementResult.newlyUnlocked) {
              io.emit('user-achievement-unlocked', {
                userId: userId,
                username: participant.username,
                achievement: achievement,
                timestamp: new Date()
              });
            }
            
            // Update user's achievement points (separate from batch to avoid conflicts)
            const totalPoints = achievementResult.newlyUnlocked.reduce((sum, a) => sum + (a.points || 0), 0);
            await db.collection('users').doc(userId).update({
              achievementPoints: admin.firestore.FieldValue.increment(totalPoints),
              totalAchievements: admin.firestore.FieldValue.increment(achievementResult.count),
              lastAchievementUnlockedAt: admin.firestore.FieldValue.serverTimestamp()
            });
          }
        }
      }

      // Clean up room from Redis and notify lobby
      if (useRedis) {
        await redisService.deleteRoom(roomId);
      }
      io.emit('room-deleted', { roomId: roomId });

    } catch (error) {
      console.error('Error handling game-finished:', error);
      
      // Notify players about error
      io.to(roomId).emit('game-error', {
        message: 'Error finalizing game results',
        error: error.message
      });
    }
  }
  
  // Get available rooms
  socket.on('get-available-rooms', async (data) => {
    try {
      const { limit = 20, roomType = 'all' } = data;
      
      let rooms = [];
      
      // Try Redis first
      if (useRedis) {
        rooms = await redisService.getAvailableRooms(limit, roomType);
      }
      
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
      
      let roomData = null;
      
      if (useRedis) {
        const result = await redisService.updatePlayerReady(roomId, userId, true);
        roomData = await redisService.getRoom(roomId);
        
        const updatedParticipant = result.participantDetails.find(p => p.userId === userId);
        
        // Notify room members
        io.to(roomId).emit('player-ready-status-changed', {
          userId: userId,
          username: socket.username,
          isReady: updatedParticipant.isReady,
          roomId: roomId
        });
        
        if (result.allReady) {
          // Start game countdown
          io.to(roomId).emit('game-starting-countdown', {
            roomId: roomId,
            countdown: 5
          });
          
          // Start game after countdown
          setTimeout(async () => {
            try {
              await redisService.updateRoom(roomId, {
                status: 'playing',
                gameStartedAt: Date.now()
              });
              
              io.to(roomId).emit('game-started', {
                roomId: roomId,
                participants: result.participantDetails
              });
            } catch (error) {
              console.error('Error starting game:', error);
            }
          }, 5000);
        }
      }
      
    } catch (error) {
      console.error('Error toggling ready status:', error);
      socket.emit('room-error', {
        message: 'Failed to update ready status'
      });
    }
  });
  
  // Broadcast game event (e.g. bug solved, question answered)
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
      let roomData = null;
      if (useRedis) {
        roomData = await redisService.getRoom(roomId);
      }
      
      if (!roomData || !roomData.participants.includes(userId)) {
        socket.emit('room-error', { message: 'You are not in this room' });
        return;
      }
      
      // Create game event
      const gameEvent = {
        userId: userId,
        username: username,
        eventType: eventType,
        eventData: eventData,
        timestamp: Date.now(),
        roomId: roomId
      };
      
      // Save to Redis
      if (useRedis) {
        await redisService.addGameEvent(roomId, gameEvent);
      }
      
      // Handle specific event types
      switch (eventType) {
        case 'test-case-passed':
        case 'bug-solved':
          const points = eventData.points || 10;
          const prevScore = roomData.participantDetails.find(p => p.userId === userId)?.score || 0;

          // Only update if score increased
          if (points > prevScore) {
            const updatedParticipantDetails = roomData.participantDetails.map(p => 
              p.userId === userId ? { ...p, score: points } : p
            );

            if (useRedis) {
              await redisService.updateRoom(roomId, { participantDetails: updatedParticipantDetails });
            }
            
            io.to(roomId).emit('score-updated', {
              userId, username,
              newScore: points, points,
              reason: eventType
            });
            
            if (useRedis) {
              try {
                await redisService.updateLeaderboard(userId, points, 'global');
                const gameType = roomData.gameSettings?.mode || 'general';
                await redisService.updateLeaderboard(userId, points, `gametype:${gameType}`);
              } catch (redisError) {
                console.error('Redis leaderboard update failed (non-critical):', redisError);
              }
            }
          }
          break;

        case 'question-answered':
          const qaPoints = eventData.points || 10;
          const updatedQADetails = roomData.participantDetails.map(p => 
            p.userId === userId ? { ...p, score: (p.score || 0) + qaPoints } : p
          );

          if (useRedis) {
            await redisService.updateRoom(roomId, { participantDetails: updatedQADetails });
          }
          
          const qaNewScore = updatedQADetails.find(p => p.userId === userId).score;
          io.to(roomId).emit('score-updated', {
            userId,
            username,
            newScore: qaNewScore,
            points: qaPoints,
            reason: eventType
          });
          
          if (useRedis) {
            try {
              await redisService.updateLeaderboard(userId, qaNewScore, 'global');
              const gameType = roomData.gameSettings?.mode || 'general';
              await redisService.updateLeaderboard(userId, qaNewScore, `gametype:${gameType}`);
            } catch (redisError) {
              console.error('Redis leaderboard update failed (non-critical):', redisError);
            }
          }
          break;

        case 'timer-update':
          io.to(roomId).emit('timer-updated', {
            timeRemaining: eventData.timeRemaining,
            totalTime: eventData.totalTime
          });
          break;
          
        case 'game-finished':
          await handleGameFinished(roomId, roomData, {
            reason: eventData?.reason || 'completed',
            triggeredBy: eventData?.triggeredBy || 'game-event'
          });
          break;

        case 'hint-used':
          // Track hint usage (optional - for analytics)
          await db.collection('gameAnalytics').add({
            userId: userId,
            username: username,
            roomId: roomId,
            eventType: 'hint-used',
            hintType: eventData.hintType || 'general',
            timestamp: admin.firestore.FieldValue.serverTimestamp()
          }).catch(err => console.error('Error saving hint analytics:', err));
          
          io.to(roomId).emit('hint-used-notification', {
            userId: userId,
            username: username,
            hintType: eventData.hintType
          });
          break;
          
        case 'player-ready-change':
          // Handle ready status change during game (for multi-round games)
          const readyUpdatedParticipants = roomData.participantDetails.map(p => {
            if (p.userId === userId) {
              return { ...p, isReady: eventData.isReady };
            }
            return p;
          });
          
          if (useRedis) {
            await redisService.updateRoom(roomId, { 
              participantDetails: readyUpdatedParticipants 
            });
          }
        
          io.to(roomId).emit('player-ready-changed', {
            userId: userId,
            username: username,
            isReady: eventData.isReady,
            roomId: roomId
          });
          
          // Check if all players are ready for next round
          const allReady = readyUpdatedParticipants.every(p => p.isReady);
          if (allReady && readyUpdatedParticipants.length >= 2) {
            io.to(roomId).emit('all-players-ready', {
              roomId: roomId,
              nextRoundStarting: true
            });
          }
          break;
          
        default:
          // Handle custom game events
          console.log(`Custom game event: ${eventType}`, eventData);
          break;
      }
      
    } catch (error) {
      console.error('Error handling game event:', error);
      socket.emit('room-error', {
        message: 'Failed to process game event',
        eventType: data.eventType
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
      
      let roomData = null;
      
      if (useRedis) {
        roomData = await redisService.getRoom(roomId);
      }
      
      socket.emit('room-details', { room: roomData });
      
    } catch (error) {
      console.error('Error getting room details:', error);
      socket.emit('room-error', {
        message: 'Failed to get room details'
      });
    }
  });
  
  // ============ MATCHMAKING EVENTS ============
  
  // Quick match
  socket.on('quick-match', async (data) => {
    try {
      const userId = socket.userId;
      const username = socket.username;
      const { skillLevel = 1000, gameSettings } = data;

      const result = await matchmakingService.quickMatch(userId, {username, skillLevel, perfectScore: gameSettings?.xp || 50 });
      
      if (result.matched) {
        // Join both players to the created room
        socket.join(result.roomId);
        
        let tempGameSettings = {
          mode: 'quick',
          timeLimit: 600, // 10 minutes
          difficulty: 'medium',
          ...gameSettings
        }

        socket.emit('match-found', { ...result, gameSettings: tempGameSettings  });
        
        // Notify opponent
        const opponentSockets = await io.in(`user_${result.opponentId}`).fetchSockets();
        if (opponentSockets.length > 0) {
          opponentSockets[0].join(result.roomId);
          opponentSockets[0].emit('match-found', { ...result, gameSettings: tempGameSettings });
          
          // Start game after countdown
          io.to(result.roomId).emit('game-starting-countdown', {
            roomId: result.roomId,
            countdown: 5
          });

          setTimeout(async () => {
            try {
              await redisService.updateRoom(result.roomId, {
                status: 'playing',
                gameStartedAt: Date.now()
              });
              
              io.to(result.roomId).emit('game-started', {
                roomId: result.roomId,
                participants: result.participantDetails
              });
            } catch (error) {
              console.error('Error starting game:', error);
            }
          }, 5000);
        }
      } else {
        socket.emit('matchmaking-queued', {
          message: result.message,
          queueStatus: result.queueStatus
        });
      }
      
    } catch (error) {
      console.error('Error in quick match:', error);
      socket.emit('matchmaking-error', {
        message: 'Failed to find match'
      });
    }
  });
  
  // Cancel matchmaking
  socket.on('cancel-matchmaking', async (data) => {
    try {
      const userId = socket.userId;
      
      await matchmakingService.removeFromQueue(userId);
      
      socket.emit('matchmaking-cancelled', {
        message: 'Matchmaking cancelled'
      });
      
    } catch (error) {
      console.error('Error cancelling matchmaking:', error);
      socket.emit('matchmaking-error', {
        message: 'Failed to cancel matchmaking'
      });
    }
  });
  
  // Get matchmaking queue status
  socket.on('get-queue-status', async (data) => {
    try {
      const userId = socket.userId;
      
      const status = await matchmakingService.getQueueStatus(userId);
      
      socket.emit('queue-status', status);
      
    } catch (error) {
      console.error('Error getting queue status:', error);
      socket.emit('matchmaking-error', {
        message: 'Failed to get queue status'
      });
    }
  });
};