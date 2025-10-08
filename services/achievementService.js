// services/achievementService.js - Achievement Management with In-Memory Cache & Firebase
const { redisClient, KEY_PREFIXES, TTL, isRedisAvailable } = require('../config/redis.config');

class AchievementService {
  
  constructor() {
    // Don't initialize db here - it will be set when Firebase Admin is ready
    this.db = null;
    
    // In-memory caches using Map
    this.achievementsCache = new Map(); // All achievements
    this.userAchievementsCache = new Map(); // User achievements by userId
    this.achievementByIdCache = new Map(); // Individual achievements by achievementId
  }
  
  // Initialize Firebase connection
  initializeFirebase(db) {
    this.db = db;
    console.log('✅ AchievementService: Firebase initialized');
  }
  
  // Helper to ensure db is initialized
  ensureDb() {
    if (!this.db) {
      throw new Error('Firebase is not initialized. Call initializeFirebase() first.');
    }
    return this.db;
  }
  
  // Clear all caches
  clearCache() {
    this.achievementsCache.clear();
    this.userAchievementsCache.clear();
    this.achievementByIdCache.clear();
    console.log('✅ Achievement caches cleared');
  }
  
  // ============ CACHE MANAGEMENT ============
  
  async cacheAllAchievements() {
    try {
      const db = this.ensureDb();
      const snapshot = await db.collection('achievements').get();
      const achievements = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));
      
      // Store in local Map cache
      this.achievementsCache.set('all', achievements);
      
      // Also cache individual achievements
      for (const achievement of achievements) {
        this.achievementByIdCache.set(achievement.achievementId, achievement);
      }
      
      // Also cache in Redis if available (fallback)
      if (isRedisAvailable()) {
        const cacheKey = KEY_PREFIXES.ACHIEVEMENT_ALL;
        await redisClient.set(cacheKey, JSON.stringify(achievements));
      }
      
      console.log(`✅ Cached ${achievements.length} achievements in memory`);
      return achievements;
    } catch (error) {
      console.error('Error caching achievements:', error);
      throw error;
    }
  }
  
  async getAllAchievements(useCache = true) {
    try {
      if (useCache) {
        const cached = this.achievementsCache.get('all');
        if (cached) {
          return cached;
        }
      }
      
      // Try Redis cache second
      if (useCache && isRedisAvailable()) {
        const cacheKey = KEY_PREFIXES.ACHIEVEMENT_ALL;
        const cached = await redisClient.get(cacheKey);
        
        if (cached) {
          const achievements = JSON.parse(cached);
          // Store in memory for next time
          this.achievementsCache.set('all', achievements);
          return achievements;
        }
      }
      
      // Fallback to Firebase
      await this.cacheAllAchievements();
      return this.achievementsCache.get('all') || [];
    } catch (error) {
      console.error('Error getting achievements:', error);
      return [];
    }
  }
  
  async getAchievementById(achievementId, useCache = true) {
    try {
      // Try in-memory cache first
      if (useCache) {
        const cached = this.achievementByIdCache.get(achievementId);
        if (cached) {
          return cached;
        }
      }
      
      // Try Redis cache second
      if (useCache && isRedisAvailable()) {
        const cacheKey = `achievement:${achievementId}`;
        const cached = await redisClient.get(cacheKey);
        
        if (cached) {
          const achievement = JSON.parse(cached);
          // Store in memory for next time
          this.achievementByIdCache.set(achievementId, achievement);
          return achievement;
        }
      }
      
      // Fallback to Firebase
      const db = this.ensureDb();
      const snapshot = await db.collection('achievements')
        .where('achievementId', '==', achievementId)
        .limit(1)
        .get();
      
      if (snapshot.empty) {
        return null;
      }
      
      const achievement = {
        id: snapshot.docs[0].id,
        ...snapshot.docs[0].data()
      };
      
      // Cache in memory
      this.achievementByIdCache.set(achievementId, achievement);
      
      // Cache in Redis if available
      if (isRedisAvailable()) {
        const cacheKey = `achievement:${achievementId}`;
        await redisClient.set(cacheKey, JSON.stringify(achievement));
        await redisClient.expire(cacheKey, 3600);
      }
      
      return achievement;
    } catch (error) {
      console.error('Error getting achievement:', error);
      return null;
    }
  }
  
  // ============ USER ACHIEVEMENTS ============
  
  async getUserAchievements(userId, useCache = true) {
    try {
      // Try in-memory cache first
      if (useCache) {
        const cached = this.userAchievementsCache.get(userId);
        if (cached && (Date.now() - cached.timestamp) < 300000) { // 5 minutes
          return cached.data;
        }
      }
      
      // Try Redis cache second
      if (useCache && isRedisAvailable()) {
        const cacheKey = `${KEY_PREFIXES.USER_ACHIEVEMENTS}:${userId}`;
        const cached = await redisClient.get(cacheKey);
        
        if (cached) {
          const data = JSON.parse(cached);
          // Store in memory for next time
          this.userAchievementsCache.set(userId, {
            data: data,
            timestamp: Date.now()
          });
          return data;
        }
      }
      
      // Fallback to Firebase
      const db = this.ensureDb();
      const snapshot = await db.collection('userAchievements')
        .where('userId', '==', userId)
        .get();
      
      const userAchievements = [];
      
      for (const doc of snapshot.docs) {
        const data = doc.data();
        const achievement = await this.getAchievementById(data.achievementId);
        
        userAchievements.push({
          id: doc.id,
          ...data,
          unlockedAt: data.unlockedAt?.toDate(),
          achievement: achievement
        });
      }
      
      // Cache in memory
      this.userAchievementsCache.set(userId, {
        data: userAchievements,
        timestamp: Date.now()
      });
      
      // Cache in Redis if available
      if (isRedisAvailable()) {
        const cacheKey = `${KEY_PREFIXES.USER_ACHIEVEMENTS}:${userId}`;
        await redisClient.set(cacheKey, JSON.stringify(userAchievements));
        await redisClient.expire(cacheKey, 300); // 5 minutes
      }
      
      return userAchievements;
    } catch (error) {
      console.error('Error getting user achievements:', error);
      return [];
    }
  }
  
  async unlockAchievement(userId, achievementId) {
    try {
      const db = this.ensureDb();
      const admin = require('firebase-admin');
      
      // Check if user already has this achievement
      const existingSnapshot = await db.collection('userAchievements')
        .where('userId', '==', userId)
        .where('achievementId', '==', achievementId)
        .limit(1)
        .get();
      
      if (!existingSnapshot.empty) {
        return { 
          success: false, 
          message: 'Achievement already unlocked',
          alreadyUnlocked: true 
        };
      }
      
      // Get achievement details
      const achievement = await this.getAchievementById(achievementId);
      
      if (!achievement) {
        return { 
          success: false, 
          message: 'Achievement not found' 
        };
      }
      
      // Create user achievement in Firebase
      const userAchievementRef = await db.collection('userAchievements').add({
        userId: userId,
        achievementId: achievementId,
        unlockedAt: admin.firestore.FieldValue.serverTimestamp(),
        progress: 100
      });
      
      // Invalidate user achievements cache
      this.userAchievementsCache.delete(userId);
      if (isRedisAvailable()) {
        await redisClient.del(`${KEY_PREFIXES.USER_ACHIEVEMENTS}:${userId}`);
      }
      
      return {
        success: true,
        message: 'Achievement unlocked!',
        achievement: achievement,
        userAchievementId: userAchievementRef.id,
        points: achievement.points
      };
      
    } catch (error) {
      console.error('Error unlocking achievement:', error);
      return { 
        success: false, 
        message: 'Failed to unlock achievement' 
      };
    }
  }
  
  async updateAchievementProgress(userId, achievementId, progress) {
    try {
      const db = this.ensureDb();
      const admin = require('firebase-admin');
      
      // Find existing user achievement
      const snapshot = await db.collection('userAchievements')
        .where('userId', '==', userId)
        .where('achievementId', '==', achievementId)
        .limit(1)
        .get();
      
      if (snapshot.empty) {
        // Create new progress entry
        await db.collection('userAchievements').add({
          userId: userId,
          achievementId: achievementId,
          unlockedAt: null,
          progress: progress
        });
      } else {
        const doc = snapshot.docs[0];
        const data = doc.data();
        
        // Update existing progress
        await doc.ref.update({ progress: progress });
        
        // Auto-unlock if progress reaches 100%
        if (progress >= 100 && !data.unlockedAt) {
          await doc.ref.update({
            unlockedAt: admin.firestore.FieldValue.serverTimestamp()
          });
          
          // Invalidate cache
          this.userAchievementsCache.delete(userId);
          if (isRedisAvailable()) {
            await redisClient.del(`${KEY_PREFIXES.USER_ACHIEVEMENTS}:${userId}`);
          }
          
          return {
            success: true,
            unlocked: true,
            progress: progress
          };
        }
      }
      
      // Invalidate cache
      this.userAchievementsCache.delete(userId);
      if (isRedisAvailable()) {
        await redisClient.del(`${KEY_PREFIXES.USER_ACHIEVEMENTS}:${userId}`);
      }
      
      return {
        success: true,
        unlocked: false,
        progress: progress
      };
      
    } catch (error) {
      console.error('Error updating achievement progress:', error);
      return { 
        success: false, 
        message: 'Failed to update progress' 
      };
    }
  }
  
  // ============ CRITERIA-SPECIFIC UPDATE FUNCTIONS ============
  
  async updateDailyStreak(userId, currentStreak) {
    try {
      const db = this.ensureDb();
      
      // Update user's daily streak in users collection
      await db.collection('users').doc(userId).update({
        dailyLoginStreak: currentStreak,
        lastLoginDate: new Date().toISOString().split('T')[0], // YYYY-MM-DD
        updatedAt: require('firebase-admin').firestore.FieldValue.serverTimestamp()
      });
      
      // Get all streak-based achievements
      const allAchievements = await this.getAllAchievements();
      const streakAchievements = allAchievements.filter(a => 
        a.criteria?.type === 'daily_streak'
      );
      
      const results = [];
      
      for (const achievement of streakAchievements) {
        const target = achievement.criteria.target;
        const progress = Math.min((currentStreak / target) * 100, 100);
        
        if (currentStreak >= target) {
          // Try to unlock
          const result = await this.unlockAchievement(userId, achievement.achievementId);
          if (result.success) {
            results.push({
              achievementId: achievement.achievementId,
              unlocked: true,
              achievement: result.achievement
            });
          }
        } else {
          // Update progress
          await this.updateAchievementProgress(userId, achievement.achievementId, progress);
          results.push({
            achievementId: achievement.achievementId,
            unlocked: false,
            progress: progress
          });
        }
      }
      
      return {
        success: true,
        currentStreak: currentStreak,
        achievements: results
      };
      
    } catch (error) {
      console.error('Error updating daily streak:', error);
      return {
        success: false,
        message: 'Failed to update daily streak'
      };
    }
  }
  
  async updateWinStreak(userId, currentWinStreak) {
    try {
      const db = this.ensureDb();
      
      // Update user's win streak in leaderboard collection
      await db.collection('leaderboard').doc(userId).update({
        currentWinStreak: currentWinStreak,
        updatedAt: require('firebase-admin').firestore.FieldValue.serverTimestamp()
      });
      
      // Get all win streak achievements
      const allAchievements = await this.getAllAchievements();
      const streakAchievements = allAchievements.filter(a => 
        a.criteria?.type === 'win_streak'
      );
      
      const results = [];
      
      for (const achievement of streakAchievements) {
        const target = achievement.criteria.target;
        const progress = Math.min((currentWinStreak / target) * 100, 100);
        
        if (currentWinStreak >= target) {
          const result = await this.unlockAchievement(userId, achievement.achievementId);
          if (result.success) {
            results.push({
              achievementId: achievement.achievementId,
              unlocked: true,
              achievement: result.achievement
            });
          }
        } else {
          await this.updateAchievementProgress(userId, achievement.achievementId, progress);
          results.push({
            achievementId: achievement.achievementId,
            unlocked: false,
            progress: progress
          });
        }
      }
      
      return {
        success: true,
        currentWinStreak: currentWinStreak,
        achievements: results
      };
      
    } catch (error) {
      console.error('Error updating win streak:', error);
      return {
        success: false,
        message: 'Failed to update win streak'
      };
    }
  }
  
  async updateFriendCount(userId, friendCount) {
    console.log('userId, friendCount', userId, friendCount)
    try {
      const db = this.ensureDb();
      
      // Update user's friend count
      await db.collection('users').doc(userId).update({
        friendCount: friendCount,
        updatedAt: require('firebase-admin').firestore.FieldValue.serverTimestamp()
      });
      
      // Get all friend-based achievements
      const allAchievements = await this.getAllAchievements();
      const friendAchievements = allAchievements.filter(a => 
        a.criteria?.type === 'friends'
      );
      
      const results = [];
      
      for (const achievement of friendAchievements) {
        const target = achievement.criteria.target;
        const progress = Math.min((friendCount / target) * 100, 100);
        
        if (friendCount >= target) {
          const result = await this.unlockAchievement(userId, achievement.achievementId);
          if (result.success) {
            results.push({
              achievementId: achievement.achievementId,
              unlocked: true,
              achievement: result.achievement
            });
          }
        } else {
          await this.updateAchievementProgress(userId, achievement.achievementId, progress);
          results.push({
            achievementId: achievement.achievementId,
            unlocked: false,
            progress: progress
          });
        }
      }
      
      return {
        success: true,
        friendCount: friendCount,
        achievements: results
      };
      
    } catch (error) {
      console.error('Error updating friend count:', error);
      return {
        success: false,
        message: 'Failed to update friend count'
      };
    }
  }
  
  async incrementPerfectGames(userId) {
    try {
      const db = this.ensureDb();
      const admin = require('firebase-admin');
      
      // Increment perfect games count
      await db.collection('leaderboard').doc(userId).update({
        perfectGames: admin.firestore.FieldValue.increment(1),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      
      // Get updated count
      const leaderboardDoc = await db.collection('leaderboard').doc(userId).get();
      const perfectGames = leaderboardDoc.data()?.perfectGames || 1;
      
      // Get all perfect score achievements
      const allAchievements = await this.getAllAchievements();
      const perfectAchievements = allAchievements.filter(a => 
        a.criteria?.type === 'perfect_score'
      );
      
      const results = [];
      
      for (const achievement of perfectAchievements) {
        const target = achievement.criteria.target;
        
        if (perfectGames >= target) {
          const result = await this.unlockAchievement(userId, achievement.achievementId);
          if (result.success) {
            results.push({
              achievementId: achievement.achievementId,
              unlocked: true,
              achievement: result.achievement
            });
          }
        }
      }
      
      return {
        success: true,
        perfectGames: perfectGames,
        achievements: results
      };
      
    } catch (error) {
      console.error('Error incrementing perfect games:', error);
      return {
        success: false,
        message: 'Failed to increment perfect games'
      };
    }
  }
  
  // ============ ACHIEVEMENT CHECKING ============
  
  async checkAndUnlockAchievements(userId, userStats) {
    try {
      const allAchievements = await this.getAllAchievements();
      const userAchievements = await this.getUserAchievements(userId);
      const unlockedIds = userAchievements.map(ua => ua.achievementId);
      
      const newlyUnlocked = [];
      
      for (const achievement of allAchievements) {
        // Skip if already unlocked
        if (unlockedIds.includes(achievement.achievementId)) {
          continue;
        }
        
        // Check criteria
        const meetsCriteria = this.checkAchievementCriteria(achievement, userStats);
        
        if (meetsCriteria.met) {
          const result = await this.unlockAchievement(userId, achievement.achievementId);
          
          if (result.success) {
            newlyUnlocked.push({
              ...achievement,
              unlockedAt: new Date()
            });
          }
        } else if (meetsCriteria.progress !== undefined) {
          // Update progress if partial
          await this.updateAchievementProgress(
            userId, 
            achievement.achievementId, 
            meetsCriteria.progress
          );
        }
      }
      
      return {
        success: true,
        newlyUnlocked: newlyUnlocked,
        count: newlyUnlocked.length
      };
      
    } catch (error) {
      console.error('Error checking achievements:', error);
      return {
        success: false,
        newlyUnlocked: [],
        count: 0
      };
    }
  }
  
  checkAchievementCriteria(achievement, userStats) {
    const { criteria } = achievement;
    
    if (!criteria || !criteria.type) {
      return { met: false };
    }
    
    const { type, target, metric } = criteria;
    
    switch (type) {
      case 'total_score':
        const score = userStats.totalScore || 0;
        if (score >= target) {
          return { met: true, progress: 100 };
        }
        return { met: false, progress: Math.min((score / target) * 100, 99) };
        
      case 'games_played':
        const games = userStats.gamesPlayed || 0;
        if (games >= target) {
          return { met: true, progress: 100 };
        }
        return { met: false, progress: Math.min((games / target) * 100, 99) };
        
      case 'win_streak':
        const streak = userStats.currentWinStreak || 0;
        if (streak >= target) {
          return { met: true, progress: 100 };
        }
        return { met: false, progress: Math.min((streak / target) * 100, 99) };
        
      case 'wins':
        const wins = userStats.wins || 0;
        if (wins >= target) {
          return { met: true, progress: 100 };
        }
        return { met: false, progress: Math.min((wins / target) * 100, 99) };
        
      case 'perfect_score':
        const perfectGames = userStats.perfectGames || 0;
        if (perfectGames >= target) {
          return { met: true, progress: 100 };
        }
        return { met: false, progress: Math.min((perfectGames / target) * 100, 99) };
      
      case 'game_type_mastery':
        const gameTypeStats = userStats.gameTypeScores?.[metric] || {};
        const gameTypeScore = gameTypeStats.score || 0;
        if (gameTypeScore >= target) {
          return { met: true, progress: 100 };
        }
        return { met: false, progress: Math.min((gameTypeScore / target) * 100, 99) };
        
      default:
        return { met: false };
    }
  }
  
  // ============ REFRESH CACHE ============
  
  async refreshAchievementsCache() {
    try {
      console.log('Refreshing achievements cache...');
      this.clearCache();
      await this.cacheAllAchievements();
      console.log('Achievements cache refreshed successfully');
      return { success: true };
    } catch (error) {
      console.error('Error refreshing achievements cache:', error);
      return { success: false, error: error.message };
    }
  }
}

module.exports = new AchievementService();