// services/matchmakingService.js - Matchmaking Logic
const { redisClient, KEY_PREFIXES, TTL } = require('../config/redis.config');
const redisService = require('./redisService');

class MatchmakingService {
  async addToQueue(userId, userProfile) {
    try {
      const queueKey = KEY_PREFIXES.MATCHMAKING_QUEUE;
      const playerKey = `${KEY_PREFIXES.PLAYER}${userId}`;
      
      // Store player data
      await redisClient.hset(playerKey, {
        userId: userId,
        username: userProfile.username,
        skillLevel: userProfile.skillLevel || 1000, // ELO-like rating
        preferredMode: userProfile.preferredMode || 'quick',
        joinedQueueAt: Date.now(),
      });
      
      // Add to matchmaking queue (sorted by skill level)
      await redisClient.zadd(
        queueKey, 
        userProfile.skillLevel || 1000, 
        userId
      );
      
      // Set TTL for queue entry
      await redisClient.expire(playerKey, TTL.MATCHMAKING_QUEUE);
      
      return { success: true, message: 'Added to matchmaking queue' };
    } catch (error) {
      console.error('Error adding to queue:', error);
      throw error;
    }
  }
  
  async removeFromQueue(userId) {
    try {
      const queueKey = KEY_PREFIXES.MATCHMAKING_QUEUE;
      const playerKey = `${KEY_PREFIXES.PLAYER}${userId}`;
      
      await Promise.all([
        redisClient.zrem(queueKey, userId),
        redisClient.del(playerKey),
      ]);
      
      return { success: true, message: 'Removed from queue' };
    } catch (error) {
      console.error('Error removing from queue:', error);
      throw error;
    }
  }
  
  async findMatch(userId, options = {}) {
    try {
      const queueKey = KEY_PREFIXES.MATCHMAKING_QUEUE;
      const playerKey = `${KEY_PREFIXES.PLAYER}${userId}`;
      
      // Get player data
      const playerData = await redisClient.hgetall(playerKey);
      if (!playerData || Object.keys(playerData).length === 0) {
        return { found: false, message: 'Player not in queue' };
      }
      
      const skillLevel = parseInt(playerData.skillLevel);
      const skillRange = options.skillRange || 1000; // Skill range for matching
      
      // Find players within skill range
      const minSkill = skillLevel - skillRange;
      const maxSkill = skillLevel + skillRange;

      // remove for temperary because limited users
      // const potentialMatches = await redisClient.zrangebyscore(
      //   queueKey,
      //   minSkill,
      //   maxSkill
      // );
      const potentialMatches = await redisClient.zrange(
        queueKey, 0, -1
      );
      
      // Remove self from potential matches
      const matches = potentialMatches.filter(id => id !== userId);
      
      if (matches.length === 0) {
        return { found: false, message: 'No suitable opponents found' };
      }
      
      // Get the best match (closest skill level)
      let bestMatch = null;
      let smallestDiff = Infinity;
      
      for (const matchId of matches) {
        const matchKey = `${KEY_PREFIXES.PLAYER}${matchId}`;
        const matchData = await redisClient.hgetall(matchKey);
        
        if (matchData && Object.keys(matchData).length > 0) {
          const matchSkill = parseInt(matchData.skillLevel);
          const diff = Math.abs(skillLevel - matchSkill);
          
          if (diff < smallestDiff) {
            smallestDiff = diff;
            bestMatch = {
              userId: matchId,
              username: matchData.username,
              skillLevel: matchSkill,
              preferredMode: matchData.preferredMode,
            };
          }
        }
      }
      
      if (!bestMatch) {
        return { found: false, message: 'No valid opponent found' };
      }
      
      return {
        found: true,
        opponent: bestMatch,
        skillDifference: smallestDiff,
      };
    } catch (error) {
      console.error('Error finding match:', error);
      throw error;
    }
  }
  
  async getQueueStatus(userId) {
    try {
      const queueKey = KEY_PREFIXES.MATCHMAKING_QUEUE;
      const playerKey = `${KEY_PREFIXES.PLAYER}${userId}`;
      
      // Check if player is in queue
      const rank = await redisClient.zrank(queueKey, userId);
      if (rank === null) {
        return { inQueue: false };
      }
      
      // Get player data
      const playerData = await redisClient.hgetall(playerKey);
      
      // Get total players in queue
      const totalInQueue = await redisClient.zcard(queueKey);
      
      // Calculate wait time
      const joinedAt = parseInt(playerData.joinedQueueAt);
      const waitTime = Date.now() - joinedAt;
      
      return {
        inQueue: true,
        position: rank + 1,
        totalInQueue: totalInQueue,
        waitTime: Math.floor(waitTime / 1000), // in seconds
        skillLevel: parseInt(playerData.skillLevel),
      };
    } catch (error) {
      console.error('Error getting queue status:', error);
      return { inQueue: false };
    }
  }
  
  // ============ AUTO MATCHMAKING ============
  
  async autoMatchPlayers(minPlayers = 2, maxPlayers = 4) {
    try {
      const queueKey = KEY_PREFIXES.MATCHMAKING_QUEUE;
      
      // Get all players in queue
      const playersInQueue = await redisClient.zrange(queueKey, 0, -1, 'WITHSCORES');
      
      if (playersInQueue.length < minPlayers * 2) {
        return { matched: false, message: 'Not enough players in queue' };
      }
      
      // Group players by skill level
      const groups = [];
      let currentGroup = [];
      
      for (let i = 0; i < playersInQueue.length; i += 2) {
        const userId = playersInQueue[i];
        const skillLevel = parseInt(playersInQueue[i + 1]);
        
        currentGroup.push({ userId, skillLevel });
        
        if (currentGroup.length >= maxPlayers) {
          groups.push(currentGroup);
          currentGroup = [];
        }
      }
      
      // Add remaining players to last group if minimum met
      if (currentGroup.length >= minPlayers) {
        groups.push(currentGroup);
      }
      
      // Create matches
      const matches = [];
      for (const group of groups) {
        if (group.length >= minPlayers) {
          matches.push({
            players: group,
            averageSkill: group.reduce((sum, p) => sum + p.skillLevel, 0) / group.length,
            timestamp: Date.now(),
          });
        }
      }
      
      return {
        matched: matches.length > 0,
        matches: matches,
        totalMatches: matches.length,
      };
    } catch (error) {
      console.error('Error auto matching players:', error);
      throw error;
    }
  }
  
  // ============ QUICK MATCH ============
  
  async quickMatch(userId, userProfile) {
    try {
      // Add to queue
      await this.addToQueue(userId, userProfile);
      
      // Try to find immediate match
      const matchResult = await this.findMatch(userId, { skillRange: 300 });
      
      if (matchResult.found) {
        // Remove both players from queue
        await this.removeFromQueue(userId);
        await this.removeFromQueue(matchResult.opponent.userId);
        
        // Create room automatically
        const roomData = {
          id: `quick_${Date.now()}_${userId}`,
          name: `Quick Match`,
          type: 'quick',
          createdBy: userId,
          creatorUsername: userProfile.username,
          maxPlayers: 2,
          currentPlayers: 2,
          participants: [userId, matchResult.opponent.userId],
          perfectScore: userProfile.perfectScore,
          participantDetails: [
            {
              userId: userId,
              username: userProfile.username,
              joinedAt: Date.now(),
              isReady: true,
              score: 0,
              skillLevel: userProfile.skillLevel || 1000,
            },
            {
              userId: matchResult.opponent.userId,
              username: matchResult.opponent.username,
              joinedAt: Date.now(),
              isReady: true,
              score: 0,
              skillLevel: matchResult.opponent.skillLevel,
            }
          ],
          status: 'waiting',
          createdAt: Date.now(),
          lastActivity: Date.now(),
        };

        await redisService.createRoom(roomData);

        return {
          matched: true,
          roomId: roomData.id,
          opponentId: matchResult.opponent.userId,
          participantDetails: roomData.participantDetails, 
          message: 'Match found! Room created.',
        };
      }
      
      return {
        matched: false,
        message: 'Searching for opponents...',
        queueStatus: await this.getQueueStatus(userId),
      };
    } catch (error) {
      console.error('Error in quick match:', error);
      throw error;
    }
  }
  
  // ============ RANKED MATCH ============
  
  async rankedMatch(userId, userProfile) {
    try {
      // Similar to quick match but with stricter skill matching
      await this.addToQueue(userId, {
        ...userProfile,
        preferredMode: 'ranked',
      });
      
      const matchResult = await this.findMatch(userId, { skillRange: 100 }); // Narrower range
      
      if (matchResult.found) {
        await this.removeFromQueue(userId);
        await this.removeFromQueue(matchResult.opponent.userId);
        
        const roomData = {
          id: `ranked_${Date.now()}_${userId}`,
          name: `Ranked Match`,
          type: 'ranked',
          createdBy: userId,
          creatorUsername: userProfile.username,
          maxPlayers: 2,
          currentPlayers: 2,
          participants: [userId, matchResult.opponent.userId],
          participantDetails: [
            {
              userId: userId,
              username: userProfile.username,
              joinedAt: Date.now(),
              isReady: true,
              score: 0,
              skillLevel: userProfile.skillLevel || 1000,
            },
            {
              userId: matchResult.opponent.userId,
              username: matchResult.opponent.username,
              joinedAt: Date.now(),
              isReady: true,
              score: 0,
              skillLevel: matchResult.opponent.skillLevel,
            }
          ],
          status: 'waiting',
          gameSettings: {
            mode: 'ranked',
            timeLimit: 600, // 10 minutes
            difficulty: 'hard',
            rankAffected: true,
          },
          createdAt: Date.now(),
          lastActivity: Date.now(),
        };
        
        await redisService.createRoom(roomData);
        
        return {
          matched: true,
          roomId: roomData.id,
          opponent: matchResult.opponent,
          skillDifference: matchResult.skillDifference,
          message: 'Ranked match found!',
        };
      }
      
      return {
        matched: false,
        message: 'Searching for ranked opponent...',
        queueStatus: await this.getQueueStatus(userId),
      };
    } catch (error) {
      console.error('Error in ranked match:', error);
      throw error;
    }
  }
  
  // ============ TEAM MATCH ============
  // there no need of team match for now but keeping for future use
  
  async teamMatch(teamLeaderId, teamMembers, options = {}) {
    try {
      const teamSize = teamMembers.length;
      const averageSkill = teamMembers.reduce((sum, m) => sum + (m.skillLevel || 1000), 0) / teamSize;
      
      // Add team to queue as a single entity
      const teamKey = `team:${teamLeaderId}:${Date.now()}`;
      await redisClient.hset(`${KEY_PREFIXES.PLAYER}${teamKey}`, {
        teamId: teamKey,
        leaderId: teamLeaderId,
        members: JSON.stringify(teamMembers),
        teamSize: teamSize,
        averageSkill: averageSkill,
        joinedQueueAt: Date.now(),
      });
      
      await redisClient.zadd(KEY_PREFIXES.MATCHMAKING_QUEUE, averageSkill, teamKey);
      
      // Try to find opposing team
      const skillRange = options.skillRange || 250;
      const potentialMatches = await redisClient.zrangebyscore(
        KEY_PREFIXES.MATCHMAKING_QUEUE,
        averageSkill - skillRange,
        averageSkill + skillRange
      );
      
      // Find team with similar size
      for (const matchKey of potentialMatches) {
        if (matchKey === teamKey) continue;
        
        const matchData = await redisClient.hgetall(`${KEY_PREFIXES.PLAYER}${matchKey}`);
        if (matchData && parseInt(matchData.teamSize) === teamSize) {
          // Match found!
          await redisClient.zrem(KEY_PREFIXES.MATCHMAKING_QUEUE, teamKey);
          await redisClient.zrem(KEY_PREFIXES.MATCHMAKING_QUEUE, matchKey);
          
          const opponentTeam = JSON.parse(matchData.members);
          
          return {
            matched: true,
            opponentTeam: opponentTeam,
            teamSize: teamSize,
            message: 'Team match found!',
          };
        }
      }
      
      return {
        matched: false,
        message: 'Searching for opponent team...',
      };
    } catch (error) {
      console.error('Error in team match:', error);
      throw error;
    }
  }
  
  // ============ UTILITY FUNCTIONS ============
  
  async getQueueStatistics() {
    try {
      const queueKey = KEY_PREFIXES.MATCHMAKING_QUEUE;
      
      const totalPlayers = await redisClient.zcard(queueKey);
      const allPlayers = await redisClient.zrange(queueKey, 0, -1, 'WITHSCORES');
      
      if (allPlayers.length === 0) {
        return {
          totalPlayers: 0,
          averageSkill: 0,
          averageWaitTime: 0,
        };
      }
      
      let totalSkill = 0;
      let totalWaitTime = 0;
      const now = Date.now();
      
      for (let i = 0; i < allPlayers.length; i += 2) {
        const userId = allPlayers[i];
        const skill = parseInt(allPlayers[i + 1]);
        totalSkill += skill;
        
        const playerData = await redisClient.hgetall(`${KEY_PREFIXES.PLAYER}${userId}`);
        if (playerData && playerData.joinedQueueAt) {
          totalWaitTime += (now - parseInt(playerData.joinedQueueAt));
        }
      }
      
      const playerCount = allPlayers.length / 2;
      
      return {
        totalPlayers: totalPlayers,
        averageSkill: Math.round(totalSkill / playerCount),
        averageWaitTime: Math.round((totalWaitTime / playerCount) / 1000), // in seconds
      };
    } catch (error) {
      console.error('Error getting queue statistics:', error);
      return {
        totalPlayers: 0,
        averageSkill: 0,
        averageWaitTime: 0,
      };
    }
  }
  
  async cleanupQueue() {
    try {
      const queueKey = KEY_PREFIXES.MATCHMAKING_QUEUE;
      const allPlayers = await redisClient.zrange(queueKey, 0, -1);
      
      let removed = 0;
      const maxWaitTime = 10 * 60 * 1000; // 10 minutes
      const now = Date.now();
      
      for (const userId of allPlayers) {
        const playerKey = `${KEY_PREFIXES.PLAYER}${userId}`;
        const playerData = await redisClient.hgetall(playerKey);
        
        if (!playerData || Object.keys(playerData).length === 0) {
          await redisClient.zrem(queueKey, userId);
          removed++;
        } else if (playerData.joinedQueueAt) {
          const waitTime = now - parseInt(playerData.joinedQueueAt);
          if (waitTime > maxWaitTime) {
            await this.removeFromQueue(userId);
            removed++;
          }
        }
      }
      
      console.log(`Cleaned up ${removed} stale queue entries`);
      return { success: true, removed };
    } catch (error) {
      console.error('Error cleaning up queue:', error);
      return { success: false, removed: 0 };
    }
  }
}

module.exports = new MatchmakingService();