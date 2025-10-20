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
  initializeFirebase(adminInstance) {
    if (!adminInstance) {
      throw new Error("Firebase Admin SDK instance must be provided.");
    }
    this.admin = adminInstance;
    this.db = adminInstance.firestore();
    console.log("AchievementService initialized with Firebase.");
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

  async updateAchievementProgress(userId, achievementId, progress) {
    try {
      const db = this.ensureDb();
      
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
            unlockedAt: this.admin.firestore.FieldValue.serverTimestamp()
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
        unlockedAt: this.admin.firestore.FieldValue.serverTimestamp(),
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
  
  async checkAndUnlockAchievements(userId, userStats) {
    try {
      const db = this.ensureDb();
      const allAchievements = await this.getAllAchievements();
      const userAchievements = await this.getUserAchievements(userId);
      const unlockedIds = new Set(userAchievements.map(ua => ua.achievementId));
      
      // Create maps for existing achievements by achievementId
      const existingAchievementsMap = new Map();
      userAchievements.forEach(ua => {
        existingAchievementsMap.set(ua.achievementId, ua);
      });
      
      const newlyUnlocked = [];
      const batch = db.batch();
      let batchCount = 0;
      const MAX_BATCH_SIZE = 500; // Firestore batch limit
      let totalPointsEarned = 0;
      
      for (const achievement of allAchievements) {
        const meetsCriteria = this.checkAchievementCriteria(achievement, userStats);
        const existingAchievement = existingAchievementsMap.get(achievement.achievementId);
        
        // Case 1: Achievement meets criteria and not yet unlocked
        if (meetsCriteria.met && !unlockedIds.has(achievement.achievementId)) {
          if (existingAchievement && existingAchievement.docId) {
            // Update existing document to unlocked
            const docRef = db.collection('userAchievements').doc(existingAchievement.docId);
            batch.update(docRef, {
              unlockedAt: this.admin.firestore.FieldValue.serverTimestamp(),
              progress: 100
            });
          } else {
            // Create new unlocked achievement
            const newDocRef = db.collection('userAchievements').doc();
            batch.set(newDocRef, {
              userId: userId,
              achievementId: achievement.achievementId,
              unlockedAt: this.admin.firestore.FieldValue.serverTimestamp(),
              progress: 100
            });
          }
          
          newlyUnlocked.push({
            ...achievement,
            unlockedAt: new Date()
          });
          
          // Accumulate points
          totalPointsEarned += achievement.points || 0;
          
          batchCount++;
        } 
        // Case 2: Achievement has progress but not yet unlocked
        else if (!meetsCriteria.met && meetsCriteria.progress !== undefined && !unlockedIds.has(achievement.achievementId)) {
          if (existingAchievement && existingAchievement.docId) {
            // Update existing progress only if changed
            if (existingAchievement.progress !== meetsCriteria.progress) {
              const docRef = db.collection('userAchievements').doc(existingAchievement.docId);
              batch.update(docRef, {
                progress: meetsCriteria.progress
              });
              batchCount++;
            }
          } else {
            // Create new progress entry
            const newDocRef = db.collection('userAchievements').doc();
            batch.set(newDocRef, {
              userId: userId,
              achievementId: achievement.achievementId,
              unlockedAt: null,
              progress: meetsCriteria.progress
            });
            batchCount++;
          }
        }
        
        // Commit batch if reaching limit
        if (batchCount >= MAX_BATCH_SIZE) {
          await batch.commit();
          batchCount = 0;
        }
      }
      
      // Add XP updates to batch if there are newly unlocked achievements
      if (totalPointsEarned > 0) {
        // Update user XP
        const userRef = db.collection('users').doc(userId);
        batch.update(userRef, {
          'stats.xp': this.admin.firestore.FieldValue.increment(totalPointsEarned)
        });
        batchCount++;
        
        const userLeaderboardRef = db.collection('leaderboard').doc(userId);
        // Update existing leaderboard entry
        batch.update(userLeaderboardRef.ref, {
          totalScore: this.admin.firestore.FieldValue.increment(totalPointsEarned),
          lastUpdated: this.admin.firestore.FieldValue.serverTimestamp()
        });
        batchCount++;
      }
      
      // Commit remaining operations
      if (batchCount > 0) {
        await batch.commit();
      }
      
      // Invalidate cache once after all updates
      if (newlyUnlocked.length > 0 || batchCount > 0) {
        this.userAchievementsCache.delete(userId);
        if (isRedisAvailable()) {
          await redisClient.del(`${KEY_PREFIXES.USER_ACHIEVEMENTS}:${userId}`);
          // Also invalidate leaderboard cache if exists
          await redisClient.del(`${KEY_PREFIXES.LEADERBOARD}:*`);
        }
      }
      
      return {
        success: true,
        newlyUnlocked: newlyUnlocked,
        count: newlyUnlocked.length,
        pointsEarned: totalPointsEarned
      };

    } catch (error) {
      console.error('Error checking achievements:', error);
      return {
        success: false,
        newlyUnlocked: [],
        count: 0,
        pointsEarned: 0,
        error: error.message
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
  
  async updateFriendCount(userId, friendCount) {
    console.log('userId, friendCount', userId, friendCount)
    try {
      const db = this.ensureDb();
      
      // Update user's friend count
      await db.collection('users').doc(userId).update({
        friendCount: friendCount,
        updatedAt: this.admin.firestore.FieldValue.serverTimestamp()
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
  
  // ============ ACHIEVEMENT CHECKING ============
  
  async checkAndUnlockAchievements(userId, userStats) {
    try {
      const allAchievements = await this.getAllAchievements();
      const userAchievements = await this.getUserAchievements(userId);
      const unlockedIds = new Set(userAchievements.map(ua => ua.achievementId));
      
      const newlyUnlocked = [];
      
      for (const achievement of allAchievements) {
        // Skip if already unlocked
        if (unlockedIds.has(achievement.achievementId)) {
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
        
      case 'achievements_unlocked':
        // Assumes userStats.unlockedAchievementCount is the number of achievements the user has
        const unlockedCount = userStats.unlockedAchievementCount || 0;
        return {
          met: unlockedCount >= target,
          progress: Math.floor(Math.min((unlockedCount / target) * 100, 100))
        };
      
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