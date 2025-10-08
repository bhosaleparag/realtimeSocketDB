// routes/achievementRoutes.js - Achievement REST API Routes
const express = require('express');
const router = express.Router();
const achievementService = require('../services/achievementService');

// Manual cache refresh endpoint
router.post('/refresh-achievements-cache', async (req, res) => {
  try {
    
    const result = await achievementService.refreshAchievementsCache();
    
    if (result.success) {      
      res.json({
        success: true,
        message: 'Achievements cache refreshed successfully'
      });
    } else {
      res.status(500).json({
        success: false,
        message: 'Failed to refresh cache',
        error: result.error
      });
    }
    
  } catch (error) {
    console.error('Error refreshing cache:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      message: error.message 
    });
  }
});

// Get all achievements (REST endpoint)
router.get('/achievements', async (req, res) => {
  try {
    const useCache = req.query.cache !== 'false';
    const achievements = await achievementService.getAllAchievements(useCache);
    
    res.json({
      success: true,
      achievements: achievements,
      count: achievements.length,
      cached: useCache
    });
    
  } catch (error) {
    console.error('Error getting achievements:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      message: error.message 
    });
  }
});

// Get user achievements (REST endpoint)
router.get('/achievements/user/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const useCache = req.query.cache !== 'false';
    
    const userAchievements = await achievementService.getUserAchievements(userId, useCache);
    
    res.json({
      success: true,
      achievements: userAchievements,
      count: userAchievements.length,
      cached: useCache
    });
    
  } catch (error) {
    console.error('Error getting user achievements:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      message: error.message 
    });
  }
});

// Get achievement by ID (REST endpoint)
router.get('/achievements/:achievementId', async (req, res) => {
  try {
    const { achievementId } = req.params;
    const useCache = req.query.cache !== 'false';
    
    const achievement = await achievementService.getAchievementById(achievementId, useCache);
    
    if (!achievement) {
      return res.status(404).json({
        success: false,
        message: 'Achievement not found'
      });
    }
    
    res.json({
      success: true,
      achievement: achievement
    });
    
  } catch (error) {
    console.error('Error getting achievement:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      message: error.message 
    });
  }
});

module.exports = router;