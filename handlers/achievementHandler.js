// handlers/achievementHandler.js - Achievement Socket Handler
const achievementService = require('../services/achievementService');
const admin = require('firebase-admin');

module.exports = ({ socket, io, db }) => {
  
  // Get all achievements
  socket.on('get-achievements', async (data) => {
    try {
      const { useCache = true } = data || {};
      
      const achievements = await achievementService.getAllAchievements(useCache);
      
      socket.emit('achievements-list', {
        achievements: achievements,
        count: achievements.length,
        timestamp: new Date()
      });
      
    } catch (error) {
      console.error('Error getting achievements:', error);
      socket.emit('achievement-error', {
        message: 'Failed to get achievements'
      });
    }
  });
  
  // Get user's achievements
  socket.on('get-my-achievements', async (data) => {
    try {
      const userId = socket.userId;
      const { useCache = true } = data || {};
      
      const userAchievements = await achievementService.getUserAchievements(userId, useCache);
      
      socket.emit('my-achievements', {
        achievements: userAchievements,
        count: userAchievements.length,
        timestamp: new Date()
      });
      
    } catch (error) {
      console.error('Error getting user achievements:', error);
      socket.emit('achievement-error', {
        message: 'Failed to get your achievements'
      });
    }
  });
  
  // Manually unlock achievement (for testing or admin)
  socket.on('unlock-achievement', async (data) => {
    try {
      const { achievementId } = data;
      const userId = socket.userId;
      const username = socket.username;
      
      if (!achievementId) {
        socket.emit('achievement-error', { message: 'Achievement ID is required' });
        return;
      }
      
      const result = await achievementService.unlockAchievement(userId, achievementId);
      
      if (result.success) {
        // Notify user
        socket.emit('achievement-unlocked', {
          achievement: result.achievement,
          points: result.points,
          timestamp: new Date()
        });
        
        // Broadcast to all users (for social features)
        io.emit('user-achievement-unlocked', {
          userId: userId,
          username: username,
          achievement: result.achievement,
          timestamp: new Date()
        });
        
        // Update user's total achievement points in Firebase
        const userRef = db.collection('users').doc(userId);
        await userRef.update({
          achievementPoints: admin.firestore.FieldValue.increment(result.points),
          totalAchievements: admin.firestore.FieldValue.increment(1),
          lastAchievementUnlockedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        
      } else {
        socket.emit('achievement-error', {
          message: result.message,
          alreadyUnlocked: result.alreadyUnlocked
        });
      }
      
    } catch (error) {
      console.error('Error unlocking achievement:', error);
      socket.emit('achievement-error', {
        message: 'Failed to unlock achievement'
      });
    }
  });

  // Update daily streak
  socket.on('update-daily-streak', async (data) => {
    try {
      const { userId, currentStreak } = data;
      console.log(userId, currentStreak)
      
      // Verify user
      if (socket.userId !== userId) {
        return socket.emit('achievement-error', { message: 'Unauthorized' });
      }
      const result = await achievementService.updateDailyStreak(userId, currentStreak);
      
      if (result.success && result.achievements.length > 0) {
        const unlocked = result.achievements.filter(a => a.unlocked);
        if (unlocked.length > 0) {
          socket.emit('achievements-unlocked-batch', {
            achievements: unlocked.map(a => a.achievement),
            count: unlocked.length
          });
        }
      }
    } catch (error) {
      console.error('Error updating daily streak:', error);
    }
  });
  
  // Update achievement progress
  socket.on('update-achievement-progress', async (data) => {
    try {
      const { achievementId, progress } = data;
      const userId = socket.userId;
      
      if (!achievementId || progress === undefined) {
        socket.emit('achievement-error', { 
          message: 'Achievement ID and progress are required' 
        });
        return;
      }
      
      const result = await achievementService.updateAchievementProgress(
        userId, 
        achievementId, 
        progress
      );
      
      if (result.success) {
        socket.emit('achievement-progress-updated', {
          achievementId: achievementId,
          progress: result.progress,
          unlocked: result.unlocked
        });
        
        // If unlocked, broadcast
        if (result.unlocked) {
          const achievement = await achievementService.getAchievementById(achievementId);
          
          socket.emit('achievement-unlocked', {
            achievement: achievement,
            points: achievement.points,
            timestamp: new Date()
          });
          
          io.emit('user-achievement-unlocked', {
            userId: userId,
            username: socket.username,
            achievement: achievement,
            timestamp: new Date()
          });
        }
      } else {
        socket.emit('achievement-error', {
          message: result.message
        });
      }
      
    } catch (error) {
      console.error('Error updating achievement progress:', error);
      socket.emit('achievement-error', {
        message: 'Failed to update achievement progress'
      });
    }
  });
  
  // Check and unlock achievements based on user stats
  socket.on('check-achievements', async (data) => {
    try {
      const userId = socket.userId;
      const username = socket.username;
      
      // Get user stats from Firebase
      const userLeaderboardDoc = await db.collection('leaderboard').doc(userId).get();
      
      if (!userLeaderboardDoc.exists) {
        socket.emit('achievement-check-complete', {
          newlyUnlocked: [],
          count: 0
        });
        return;
      }
      
      const userStats = userLeaderboardDoc.data();
      
      // Check achievements
      const result = await achievementService.checkAndUnlockAchievements(userId, userStats);
      
      if (result.success && result.newlyUnlocked.length > 0) {
        // Notify user of all newly unlocked achievements
        socket.emit('achievements-unlocked-batch', {
          achievements: result.newlyUnlocked,
          count: result.count,
          timestamp: new Date()
        });
        
        // Broadcast each achievement
        for (const achievement of result.newlyUnlocked) {
          io.emit('user-achievement-unlocked', {
            userId: userId,
            username: username,
            achievement: achievement,
            timestamp: new Date()
          });
        }
        
        // Update user's total achievement points
        const totalPoints = result.newlyUnlocked.reduce((sum, a) => sum + (a.points || 0), 0);
        const userRef = db.collection('users').doc(userId);
        await userRef.update({
          achievementPoints: admin.firestore.FieldValue.increment(totalPoints),
          totalAchievements: admin.firestore.FieldValue.increment(result.count),
          lastAchievementUnlockedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }
      
      socket.emit('achievement-check-complete', {
        newlyUnlocked: result.newlyUnlocked,
        count: result.count
      });
      
    } catch (error) {
      console.error('Error checking achievements:', error);
      socket.emit('achievement-error', {
        message: 'Failed to check achievements'
      });
    }
  });
  
  // Get achievement by ID
  socket.on('get-achievement-details', async (data) => {
    try {
      const { achievementId } = data;
      
      if (!achievementId) {
        socket.emit('achievement-error', { message: 'Achievement ID is required' });
        return;
      }
      
      const achievement = await achievementService.getAchievementById(achievementId);
      
      if (achievement) {
        socket.emit('achievement-details', {
          achievement: achievement
        });
      } else {
        socket.emit('achievement-error', {
          message: 'Achievement not found'
        });
      }
      
    } catch (error) {
      console.error('Error getting achievement details:', error);
      socket.emit('achievement-error', {
        message: 'Failed to get achievement details'
      });
    }
  });
};