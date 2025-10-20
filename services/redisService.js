// services/redisService.js - Core Redis Operations
const { redisClient, KEY_PREFIXES, TTL } = require('../config/redis.config');

class RedisService {

  // ============ ROOM OPERATIONS ============
  
  async createRoom(roomData) {
    try {
      const roomKey = `${KEY_PREFIXES.ROOM}${roomData.id}`;
      const playersKey = `${KEY_PREFIXES.ROOM_PLAYERS}${roomData.id}`;
      
      // Store room data as hash
      await redisClient.hset(roomKey, {
        id: roomData.id,
        name: roomData.name,
        type: roomData.type,
        createdBy: roomData.createdBy,
        creatorUsername: roomData.creatorUsername,
        maxPlayers: roomData.maxPlayers,
        currentPlayers: roomData.currentPlayers,
        status: roomData.status,
        gameSettings: JSON.stringify(roomData.gameSettings),
        createdAt: Date.now(),
        lastActivity: Date.now(),
      });
      
      // Set TTL
      await redisClient.expire(roomKey, TTL.ROOM_WAITING);
      
      // Add to active rooms set
      await redisClient.sadd(KEY_PREFIXES.ROOMS_ACTIVE, roomData.id);
      
      // Add to waiting rooms sorted set (sorted by creation time)
      await redisClient.zadd(KEY_PREFIXES.ROOMS_WAITING, Date.now(), roomData.id);
      
      // Add creator to room players set
      await redisClient.sadd(playersKey, roomData.createdBy);
      
      // Store participant details as JSON
      await redisClient.hset(roomKey, 'participantDetails', JSON.stringify(roomData.participantDetails));

      // Store participant details as JSON
      await redisClient.hset(roomKey, 'participants', JSON.stringify(roomData.participants));
      
      return { success: true, roomId: roomData.id };
    } catch (error) {
      console.error('Redis createRoom error:', error);
      throw error;
    }
  }
  
  async getRoom(roomId) {
    try {
      const roomKey = `${KEY_PREFIXES.ROOM}${roomId}`;
      const roomData = await redisClient.hgetall(roomKey);

      if (!roomData || Object.keys(roomData).length === 0) {
        return null;
      }
      
      // Parse JSON fields
      return {
        ...roomData,
        gameSettings: JSON.parse(roomData.gameSettings || '{}'),
        participantDetails: JSON.parse(roomData.participantDetails || '[]'),
        participants: JSON.parse(roomData.participants || '[]'),
        maxPlayers: parseInt(roomData.maxPlayers),
        currentPlayers: parseInt(roomData.currentPlayers),
        createdAt: parseInt(roomData.createdAt),
        lastActivity: parseInt(roomData.lastActivity),
      };
    } catch (error) {
      console.error('Redis getRoom error:', error);
      return null;
    }
  }
  
  async updateRoom(roomId, updates) {
    try {
      const roomKey = `${KEY_PREFIXES.ROOM}${roomId}`;
      
      // Convert objects to JSON strings
      const processedUpdates = {};
      for (const [key, value] of Object.entries(updates)) {
        if (typeof value === 'object' && value !== null) {
          processedUpdates[key] = JSON.stringify(value);
        } else {
          processedUpdates[key] = value;
        }
      }
      
      // Update last activity
      processedUpdates.lastActivity = Date.now();
      
      await redisClient.hset(roomKey, processedUpdates);
      
      // Update TTL based on status
      if (updates.status === 'playing') {
        await redisClient.expire(roomKey, TTL.ROOM_PLAYING);
      } else if (updates.status === 'finished') {
        await redisClient.expire(roomKey, TTL.ROOM_FINISHED);
      }
      
      return { success: true };
    } catch (error) {
      console.error('Redis updateRoom error:', error);
      throw error;
    }
  }
  
  async deleteRoom(roomId) {
    try {
      const roomKey = `${KEY_PREFIXES.ROOM}${roomId}`;
      const playersKey = `${KEY_PREFIXES.ROOM_PLAYERS}${roomId}`;
      const eventsKey = `${KEY_PREFIXES.ROOM_EVENTS}${roomId}`;
      const gameStateKey = `${KEY_PREFIXES.GAME_STATE}${roomId}`;
      
      // Delete all room-related keys
      await Promise.all([
        redisClient.del(roomKey),
        redisClient.del(playersKey),
        redisClient.del(eventsKey),
        redisClient.del(gameStateKey),
        redisClient.srem(KEY_PREFIXES.ROOMS_ACTIVE, roomId),
        redisClient.zrem(KEY_PREFIXES.ROOMS_WAITING, roomId),
      ]);
      
      return { success: true };
    } catch (error) {
      console.error('Redis deleteRoom error:', error);
      throw error;
    }
  }
  
  async addPlayerToRoom(roomId, userId, username, skillLevel) {
    try {
      const roomKey = `${KEY_PREFIXES.ROOM}${roomId}`;
      const playersKey = `${KEY_PREFIXES.ROOM_PLAYERS}${roomId}`;
      
      // Add player to room players set
      await redisClient.sadd(playersKey, userId);
      
      // Get current participant details
      const room = await this.getRoom(roomId);
      if (!room) throw new Error('Room not found');
      
      const participantDetails = room.participantDetails || [];
      participantDetails.push({
        userId: userId,
        username: username,
        skillLevel: skillLevel,
        joinedAt: Date.now(),
        isReady: false,
        score: 0,
      });
      
      // Update room
      await redisClient.hset(roomKey, {
        participantDetails: JSON.stringify(participantDetails),
        currentPlayers: participantDetails.length,
        participants: JSON.stringify(participantDetails.map(p => p.userId)),
        lastActivity: Date.now(),
      });
      
      return { success: true };
    } catch (error) {
      console.error('Redis addPlayerToRoom error:', error);
      throw error;
    }
  }
  
  async removePlayerFromRoom(roomId, userId) {
    try {
      const roomKey = `${KEY_PREFIXES.ROOM}${roomId}`;
      const playersKey = `${KEY_PREFIXES.ROOM_PLAYERS}${roomId}`;
      
      // Remove player from room players set
      await redisClient.srem(playersKey, userId);
      
      // Get current participant details
      const room = await this.getRoom(roomId);
      if (!room) return { success: true, roomDeleted: true };
      
      const participantDetails = room.participantDetails.filter(p => p.userId !== userId);
      
      // If no players left, delete room
      if (participantDetails.length === 0) {
        await this.deleteRoom(roomId);
        return { success: true, roomDeleted: true };
      }
      
      // If creator left, assign new creator
      let updates = {
        participantDetails: JSON.stringify(participantDetails),
        currentPlayers: participantDetails.length,
        participants: JSON.stringify(participantDetails.map(p => p.userId)),
        lastActivity: Date.now(),
      };
      
      if (room.createdBy === userId) {
        updates.createdBy = participantDetails[0].userId;
        updates.creatorUsername = participantDetails[0].username;
      }
      
      await redisClient.hset(roomKey, updates);
      
      return { success: true, roomDeleted: false };
    } catch (error) {
      console.error('Redis removePlayerFromRoom error:', error);
      throw error;
    }
  }
  
  async getAvailableRooms(limit = 20, roomType = 'all') {
    try {
      // Get waiting rooms sorted by creation time (newest first)
      const roomIds = await redisClient.zrevrange(KEY_PREFIXES.ROOMS_WAITING, 0, limit - 1);
      
      const rooms = [];
      for (const roomId of roomIds) {
        const room = await this.getRoom(roomId);
        if (room && (roomType === 'all' || room.type === roomType)) {
          // Check if room is not full
          if (room.currentPlayers < room.maxPlayers) {
            rooms.push(room);
          }
        }
      }
      
      return rooms;
    } catch (error) {
      console.error('Redis getAvailableRooms error:', error);
      return [];
    }
  }
  
  async getRoomPlayers(roomId) {
    try {
      const playersKey = `${KEY_PREFIXES.ROOM_PLAYERS}${roomId}`;
      return await redisClient.smembers(playersKey);
    } catch (error) {
      console.error('Redis getRoomPlayers error:', error);
      return [];
    }
  }
  
  async updatePlayerReady(roomId, userId, isReady) {
    try {
      const room = await this.getRoom(roomId);
      if (!room) throw new Error('Room not found');
      
      const participantDetails = room.participantDetails.map(p => {
        if (p.userId === userId) {
          return { ...p, isReady: isReady };
        }
        return p;
      });
      
      await this.updateRoom(roomId, { participantDetails });
      
      // Check if all players are ready
      const allReady = participantDetails.every(p => p.isReady);
      const hasMinimumPlayers = participantDetails.length >= 2;
      
      return {
        success: true,
        allReady: allReady && hasMinimumPlayers,
        participantDetails,
      };
    } catch (error) {
      console.error('Redis updatePlayerReady error:', error);
      throw error;
    }
  }
  
  // ============ GAME STATE OPERATIONS ============
  
  async setGameState(roomId, gameState) {
    try {
      const stateKey = `${KEY_PREFIXES.GAME_STATE}${roomId}`;
      await redisClient.set(stateKey, JSON.stringify(gameState));
      await redisClient.expire(stateKey, TTL.GAME_STATE);
      return { success: true };
    } catch (error) {
      console.error('Redis setGameState error:', error);
      throw error;
    }
  }
  
  async getGameState(roomId) {
    try {
      const stateKey = `${KEY_PREFIXES.GAME_STATE}${roomId}`;
      const state = await redisClient.get(stateKey);
      return state ? JSON.parse(state) : null;
    } catch (error) {
      console.error('Redis getGameState error:', error);
      return null;
    }
  }
  
  // ============ GAME EVENTS ============
  
  async addGameEvent(roomId, eventData) {
    try {
      const eventsKey = `${KEY_PREFIXES.ROOM_EVENTS}${roomId}`;
      await redisClient.rpush(eventsKey, JSON.stringify({
        ...eventData,
        timestamp: Date.now(),
      }));
      await redisClient.expire(eventsKey, TTL.ROOM_PLAYING);
      
      // Keep only last 100 events
      await redisClient.ltrim(eventsKey, -100, -1);
      
      return { success: true };
    } catch (error) {
      console.error('Redis addGameEvent error:', error);
      throw error;
    }
  }
  
  async getGameEvents(roomId, limit = 50) {
    try {
      const eventsKey = `${KEY_PREFIXES.ROOM_EVENTS}${roomId}`;
      const events = await redisClient.lrange(eventsKey, -limit, -1);
      return events.map(e => JSON.parse(e));
    } catch (error) {
      console.error('Redis getGameEvents error:', error);
      return [];
    }
  }
  
  // ============ LEADERBOARD OPERATIONS ============
  
  async updateLeaderboard(userId, score, leaderboardType = 'global') {
    try {
      const leaderboardKey = leaderboardType === 'global' 
        ? KEY_PREFIXES.LEADERBOARD_GLOBAL 
        : KEY_PREFIXES.LEADERBOARD_WEEKLY;
      
      await redisClient.zadd(leaderboardKey, score, userId);
      return { success: true };
    } catch (error) {
      console.error('Redis updateLeaderboard error:', error);
      throw error;
    }
  }
  
  async getLeaderboard(limit = 10, leaderboardType = 'global') {
    try {
      const leaderboardKey = leaderboardType === 'global' 
        ? KEY_PREFIXES.LEADERBOARD_GLOBAL 
        : KEY_PREFIXES.LEADERBOARD_WEEKLY;
      
      const results = await redisClient.zrevrange(
        leaderboardKey, 
        0, 
        limit - 1, 
        'WITHSCORES'
      );
      
      const leaderboard = [];
      for (let i = 0; i < results.length; i += 2) {
        leaderboard.push({
          userId: results[i],
          score: parseInt(results[i + 1]),
          rank: Math.floor(i / 2) + 1,
        });
      }
      
      return leaderboard;
    } catch (error) {
      console.error('Redis getLeaderboard error:', error);
      return [];
    }
  }
  
  async getUserRank(userId, leaderboardType = 'global') {
    try {
      const leaderboardKey = leaderboardType === 'global' 
        ? KEY_PREFIXES.LEADERBOARD_GLOBAL 
        : KEY_PREFIXES.LEADERBOARD_WEEKLY;
      
      const rank = await redisClient.zrevrank(leaderboardKey, userId);
      const score = await redisClient.zscore(leaderboardKey, userId);
      
      return {
        rank: rank !== null ? rank + 1 : null,
        score: score ? parseInt(score) : 0,
      };
    } catch (error) {
      console.error('Redis getUserRank error:', error);
      return { rank: null, score: 0 };
    }
  }
  
  // ============ UTILITY OPERATIONS ============
  
  // Store detailed user leaderboard data
  async setUserLeaderboardData(userId, data) {
    try {
      const userKey = `${KEY_PREFIXES.PLAYER}leaderboard:${userId}`;
      await redisClient.hset(userKey, data);
      await redisClient.expire(userKey, TTL.PLAYER_SESSION);
      return { success: true };
    } catch (error) {
      console.error('Redis setUserLeaderboardData error:', error);
      throw error;
    }
  }
  
  async getUserLeaderboardData(userId) {
    try {
      const userKey = `${KEY_PREFIXES.PLAYER}leaderboard:${userId}`;
      const data = await redisClient.hgetall(userKey);
      
      if (!data || Object.keys(data).length === 0) {
        return null;
      }
      
      return {
        ...data,
        totalScore: parseInt(data.totalScore || 0),
        gamesPlayed: parseInt(data.gamesPlayed || 0),
        wins: parseInt(data.wins || 0),
        losses: parseInt(data.losses || 0),
        averageScore: parseFloat(data.averageScore || 0),
        lastUpdated: parseInt(data.lastUpdated || 0)
      };
    } catch (error) {
      console.error('Redis getUserLeaderboardData error:', error);
      return null;
    }
  }
  
  // Cache leaderboard stats
  async cacheLeaderboardStats(stats) {
    try {
      const statsKey = 'leaderboard:stats:global';
      await redisClient.set(statsKey, JSON.stringify(stats));
      await redisClient.expire(statsKey, 300); // 5 minutes TTL
      return { success: true };
    } catch (error) {
      console.error('Redis cacheLeaderboardStats error:', error);
      throw error;
    }
  }
  
  async getLeaderboardStats() {
    try {
      const statsKey = 'leaderboard:stats:global';
      const stats = await redisClient.get(statsKey);
      return stats ? JSON.parse(stats) : null;
    } catch (error) {
      console.error('Redis getLeaderboardStats error:', error);
      return null;
    }
  }
  
  async cleanupExpiredRooms() {
    try {
      const activeRooms = await redisClient.smembers(KEY_PREFIXES.ROOMS_ACTIVE);
      let cleanedCount = 0;
      
      for (const roomId of activeRooms) {
        const room = await this.getRoom(roomId);
        if (!room) {
          await this.deleteRoom(roomId);
          cleanedCount++;
        }
      }
      
      console.log(`Cleaned up ${cleanedCount} expired rooms`);
      return { success: true, cleanedCount };
    } catch (error) {
      console.error('Redis cleanupExpiredRooms error:', error);
      return { success: false, cleanedCount: 0 };
    }
  }

  // ============ CHAT OPERATIONS ============
  // Add to your redisService class (ioredis version)

  // Room Messages
  async saveRoomMessage(roomId, messageData) {
    const key = `room:${roomId}:messages`;
    await redisClient.zadd(key, messageData.timestamp, JSON.stringify(messageData));
    await redisClient.expire(key, 86400 * 7); // 7 days
  }

  async getRoomMessages(roomId, limit = 50, before = null) {
    const key = `room:${roomId}:messages`;
    const max = before || '+inf';
    const messages = await redisClient.zrevrangebyscore(key, max, '-inf', 'LIMIT', 0, limit);
    return messages.map(msg => JSON.parse(msg)).reverse();
  }

  async updateRoomMessage(roomId, messageId, updates) {
    const messages = await this.getRoomMessages(roomId, 1000);
    const message = messages.find(msg => msg.id === messageId);
    if (message) {
      Object.assign(message, updates);
      const key = `room:${roomId}:messages`;
      // Remove old entry
      const allMessages = await redisClient.zrange(key, 0, -1);
      const oldMessage = allMessages.find(m => {
        const parsed = JSON.parse(m);
        return parsed.id === messageId;
      });
      if (oldMessage) {
        await redisClient.zrem(key, oldMessage);
      }
      // Add updated message
      await redisClient.zadd(key, message.timestamp, JSON.stringify(message));
    }
  }

  async deleteRoomMessage(roomId, messageId) {
    const key = `room:${roomId}:messages`;
    const allMessages = await redisClient.zrange(key, 0, -1);
    const messageToDelete = allMessages.find(m => {
      const parsed = JSON.parse(m);
      return parsed.id === messageId;
    });
    if (messageToDelete) {
      await redisClient.zrem(key, messageToDelete);
    }
  }

  // Friend Messages
  async saveFriendMessage(conversationId, messageData) {
    const key = `conversation:${conversationId}:messages`;
    await redisClient.zadd(key, messageData.timestamp, JSON.stringify(messageData));
    await redisClient.expire(key, 86400 * 30); // 30 days
  }

  async getFriendMessages(conversationId, limit = 50, before = null) {
    const key = `conversation:${conversationId}:messages`;
    const max = before || '+inf';
    const messages = await redisClient.zrevrangebyscore(key, max, '-inf', 'LIMIT', 0, limit);
    return messages.map(msg => JSON.parse(msg)).reverse();
  }

  async updateFriendMessage(conversationId, messageId, updates) {
    const messages = await this.getFriendMessages(conversationId, 1000);
    const message = messages.find(msg => msg.id === messageId);
    if (message) {
      Object.assign(message, updates);
      const key = `conversation:${conversationId}:messages`;
      // Remove old entry
      const allMessages = await redisClient.zrange(key, 0, -1);
      const oldMessage = allMessages.find(m => {
        const parsed = JSON.parse(m);
        return parsed.id === messageId;
      });
      if (oldMessage) {
        await redisClient.zrem(key, oldMessage);
      }
      // Add updated message
      await redisClient.zadd(key, message.timestamp, JSON.stringify(message));
    }
  }

  async deleteFriendMessage(conversationId, messageId) {
    const key = `conversation:${conversationId}:messages`;
    const allMessages = await redisClient.zrange(key, 0, -1);
    const messageToDelete = allMessages.find(m => {
      const parsed = JSON.parse(m);
      return parsed.id === messageId;
    });
    if (messageToDelete) {
      await redisClient.zrem(key, messageToDelete);
    }
  }

  // ============ FRIENDS OPERATIONS ============

  // Friends Management
  async addFriend(userId, friendId, friendData) {
    const key = `user:${userId}:friends`;
    const friends = await this.getUserFriends(userId);
    friends[friendId] = friendData;
    await redisClient.set(key, JSON.stringify(friends), 'EX', 86400 * 365); // 1 year
  }

  async getUserFriends(userId) {
    const key = `user:${userId}:friends`;
    const data = await redisClient.get(key);
    return data ? JSON.parse(data) : {};
  }

  async getFriend(userId, friendId) {
    const friends = await this.getUserFriends(userId);
    return friends[friendId] || null;
  }

  async updateFriendStatus(userId, friendId, status) {
    const friends = await this.getUserFriends(userId);
    if (friends[friendId]) {
      friends[friendId].status = status;
      const key = `user:${userId}:friends`;
      await redisClient.set(key, JSON.stringify(friends), 'EX', 86400 * 365);
    }
  }

  async removeFriend(userId, friendId) {
    const friends = await this.getUserFriends(userId);
    delete friends[friendId];
    const key = `user:${userId}:friends`;
    await redisClient.set(key, JSON.stringify(friends), 'EX', 86400 * 365);
  }

  async getAllPlayerSessions() {
    const keys = await redisClient.keys('player:*');
    return keys.map(key => key.replace('player:', ''));
  }
}


module.exports = new RedisService();