// handlers/leaderboardHandler.js - Real-time Leaderboard Management
const admin = require('firebase-admin');

module.exports = ({ socket, io, db }) => {
  
  // Update user score
  socket.on('update-score', async (data) => {
    try {
      const { points, reason, gameType = 'general' } = data;
      const userId = socket.userId;
      const username = socket.username;
      
      if (!points || isNaN(points)) {
        socket.emit('leaderboard-error', { message: 'Valid points value is required' });
        return;
      }
      // Get or create user leaderboard entry
      const userLeaderboardRef = db.collection('leaderboard').doc(userId);
      const userLeaderboardDoc = await userLeaderboardRef.get();
      let currentData = {
        userId: userId,
        username: username,
        totalScore: 0,
        gamesPlayed: 0,
        wins: 0,
        losses: 0,
        averageScore: 0,
        lastPlayed: null,
        achievements: [],
        gameTypeScores: {}
      };
      
      if (userLeaderboardDoc.exists) {
        currentData = { ...currentData, ...userLeaderboardDoc.data() };
      }
      
      // Update scores
      const newTotalScore = currentData.totalScore + points;
      const newGamesPlayed = currentData.gamesPlayed + 1;
      const newAverageScore = newTotalScore / newGamesPlayed;
      
      // Update game type specific scores
      const gameTypeScores = currentData.gameTypeScores || {};
      gameTypeScores[gameType] = {
        score: (gameTypeScores[gameType]?.score || 0) + points,
        gamesPlayed: (gameTypeScores[gameType]?.gamesPlayed || 0) + 1
      };
      
      const updatedData = {
        userId: userId,
        username: username,
        totalScore: newTotalScore,
        gamesPlayed: newGamesPlayed,
        averageScore: Math.round(newAverageScore * 100) / 100,
        lastPlayed: admin.firestore.FieldValue.serverTimestamp(),
        gameTypeScores: gameTypeScores,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      };
      
      // Save to Firebase
      await userLeaderboardRef.set(updatedData, { merge: true });
      
      // Log score update
      // await db.collection('scoreHistory').add({
      //   userId: userId,
      //   username: username,
      //   points: points,
      //   reason: reason,
      //   gameType: gameType,
      //   totalScoreAfter: newTotalScore,
      //   timestamp: admin.firestore.FieldValue.serverTimestamp()
      // });
      
      // Prepare broadcast data
      const broadcastData = {
        userId: userId,
        username: username,
        points: points,
        totalScore: newTotalScore,
        reason: reason,
        gameType: gameType,
        timestamp: new Date()
      };
      
      // Broadcast score update
      io.emit('score-updated', broadcastData);
      
      // Check for achievements
      const achievements = await checkAchievements(userId, updatedData, db);
      if (achievements.length > 0) {
        await userLeaderboardRef.update({
          achievements: admin.firestore.FieldValue.arrayUnion(...achievements)
        });
        
        io.emit('achievements-unlocked', {
          userId: userId,
          username: username,
          achievements: achievements
        });
      }
      
      // Notify user
      socket.emit('score-update-success', {
        points: points,
        totalScore: newTotalScore,
        newAchievements: achievements
      });
      
    } catch (error) {
      console.error('Error updating score:', error);
      socket.emit('leaderboard-error', {
        message: 'Failed to update score'
      });
    }
  });
  
  // Get leaderboard
  socket.on('get-leaderboard', async (data) => {
    try {
      const { 
        limit = 50, 
        gameType = 'all', 
        sortBy = 'totalScore',
        timeframe = 'all' 
      } = data;
      
      let query = db.collection('leaderboard');

      // Timeframe filter
      if (timeframe !== 'all') {
        const timeLimit = getTimeLimit(timeframe);
        query = query.where('lastPlayed', '>=', timeLimit);
      }

      // If sorting by winRate, we can’t do it in Firestore
      if (sortBy !== 'winRate') {
        query = query.orderBy(sortBy, 'desc').limit(limit);
      }

      const snapshot = await query.get();
      let docs = snapshot.docs.map(doc => doc.data());

      // Handle winRate sorting manually
      if (sortBy === 'winRate') {
        docs = docs.sort((a, b) => {
          const winRateA = a.gamesPlayed > 0 ? ((a.wins || 0) / a.gamesPlayed) * 100 : 0;
          const winRateB = b.gamesPlayed > 0 ? ((b.wins || 0) / b.gamesPlayed) * 100 : 0;
          return winRateB - winRateA; // descending
        }).slice(0, limit);
      }

      // Build leaderboard array
      const leaderboard = docs.map((data, index) => {
        const rank = index + 1;

        // Game-type specific score
        let displayScore = data.totalScore;
        if (gameType !== 'all' && data.gameTypeScores && data.gameTypeScores[gameType]) {
          displayScore = data.gameTypeScores[gameType].score;
        }

        // Compute winRate if needed
        const winRate = data.gamesPlayed > 0
          ? Math.round(((data.wins || 0) / data.gamesPlayed) * 100)
          : 0;

        return {
          rank,
          userId: data.userId,
          username: data.username,
          totalScore: data.totalScore,
          displayScore,
          gamesPlayed: data.gamesPlayed,
          averageScore: data.averageScore,
          wins: data.wins || 0,
          losses: data.losses || 0,
          winRate,
          lastPlayed: data.lastPlayed?.toDate(),
          achievements: data.achievements || [],
          gameTypeScores: data.gameTypeScores || {}
        };
      });

      socket.emit('leaderboard-data', {
        leaderboard,
        gameType,
        sortBy,
        timeframe,
        totalEntries: leaderboard.length,
        lastUpdated: new Date()
      });

    } catch (error) {
      console.error('Error getting leaderboard:', error);
      socket.emit('leaderboard-error', {
        message: 'Failed to get leaderboard'
      });
    }
  });

  
  // Get user's leaderboard position
  socket.on('get-my-position', async (data) => {
    try {
      const { gameType = 'all' } = data;
      const userId = socket.userId;
      
      // Get user's data
      const userDoc = await db.collection('leaderboard').doc(userId).get();
      
      if (!userDoc.exists) {
        socket.emit('my-position', {
          position: 'Unranked',
          totalScore: 0,
          gamesPlayed: 0
        });
        return;
      }
      
      const userData = userDoc.data();
      
      // Count users with higher scores
      let query = db.collection('leaderboard');
      
      if (gameType === 'all') {
        query = query.where('totalScore', '>', userData.totalScore);
      } else {
        // For specific game type, we need to get all docs and filter
        const allUsersSnapshot = await db.collection('leaderboard').get();
        let higherScoreCount = 0;
        
        const userGameTypeScore = userData.gameTypeScores?.[gameType]?.score || 0;
        
        allUsersSnapshot.forEach(doc => {
          const docData = doc.data();
          const docGameTypeScore = docData.gameTypeScores?.[gameType]?.score || 0;
          if (docGameTypeScore > userGameTypeScore) {
            higherScoreCount++;
          }
        });
        
        socket.emit('my-position', {
          position: higherScoreCount + 1,
          totalScore: userData.totalScore,
          gameTypeScore: userGameTypeScore,
          gamesPlayed: userData.gamesPlayed,
          averageScore: userData.averageScore,
          achievements: userData.achievements || [],
          gameType: gameType
        });
        return;
      }
      
      const higherScoreSnapshot = await query.get();
      const position = higherScoreSnapshot.size + 1;
      
      socket.emit('my-position', {
        position: position,
        totalScore: userData.totalScore,
        gamesPlayed: userData.gamesPlayed,
        averageScore: userData.averageScore,
        achievements: userData.achievements || []
      });
      
    } catch (error) {
      console.error('Error getting user position:', error);
      socket.emit('leaderboard-error', {
        message: 'Failed to get your position'
      });
    }
  });
  
  // Record game result (win/loss)
  socket.on('record-game-result', async (data) => {
    try {
      const { result, roomId, finalScore, gameType = 'general' } = data;
      const userId = socket.userId;
      
      if (!['win', 'loss', 'draw'].includes(result)) {
        socket.emit('leaderboard-error', { message: 'Invalid game result' });
        return;
      }
      
      const userLeaderboardRef = db.collection('leaderboard').doc(userId);
      const userDoc = await userLeaderboardRef.get();
      
      let updateData = {};
      
      if (result === 'win') {
        updateData.wins = admin.firestore.FieldValue.increment(1);
      } else if (result === 'loss') {
        updateData.losses = admin.firestore.FieldValue.increment(1);
      }
      
      updateData.lastPlayed = admin.firestore.FieldValue.serverTimestamp();
      
      await userLeaderboardRef.update(updateData);
      
      // Log game result
      await db.collection('gameResults').add({
        userId: userId,
        username: socket.username,
        result: result,
        roomId: roomId,
        finalScore: finalScore,
        gameType: gameType,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });
      
      // Broadcast game result
      io.emit('game-result-recorded', {
        userId: userId,
        username: socket.username,
        result: result,
        finalScore: finalScore,
        gameType: gameType
      });
      
      socket.emit('game-result-success', {
        result: result,
        message: `Game result recorded: ${result}`
      });
      
    } catch (error) {
      console.error('Error recording game result:', error);
      socket.emit('leaderboard-error', {
        message: 'Failed to record game result'
      });
    }
  });
  
  // Get leaderboard stats
  socket.on('get-leaderboard-stats', async () => {
    try {
      // Get total users
      const totalUsersSnapshot = await db.collection('leaderboard').count().get();
      const totalUsers = totalUsersSnapshot.data().count;
      
      // Get top score
      const topScoreSnapshot = await db.collection('leaderboard')
        .orderBy('totalScore', 'desc')
        .limit(1)
        .get();
      
      let topScore = 0;
      let topPlayer = null;
      
      if (!topScoreSnapshot.empty) {
        const topData = topScoreSnapshot.docs[0].data();
        topScore = topData.totalScore;
        topPlayer = topData.username;
      }
      
      // Get average score
      const allUsersSnapshot = await db.collection('leaderboard').get();
      let totalScore = 0;
      let totalGames = 0;
      
      allUsersSnapshot.forEach(doc => {
        const data = doc.data();
        totalScore += data.totalScore || 0;
        totalGames += data.gamesPlayed || 0;
      });
      
      const averageScore = totalUsers > 0 ? Math.round(totalScore / totalUsers) : 0;
      const averageGamesPlayed = totalUsers > 0 ? Math.round(totalGames / totalUsers) : 0;
      
      socket.emit('leaderboard-stats', {
        totalUsers: totalUsers,
        topScore: topScore,
        topPlayer: topPlayer,
        averageScore: averageScore,
        averageGamesPlayed: averageGamesPlayed,
        totalGamesPlayed: totalGames,
        timestamp: new Date()
      });
      
    } catch (error) {
      console.error('Error getting leaderboard stats:', error);
      socket.emit('leaderboard-error', {
        message: 'Failed to get leaderboard statistics'
      });
    }
  });
  
  // Subscribe to live leaderboard updates
  socket.on('subscribe-leaderboard-updates', (data) => {
    const { gameType = 'all' } = data;
    
    // Join leaderboard update room
    socket.join(`leaderboard-${gameType}`);
    
    socket.emit('subscribed-to-leaderboard', {
      gameType: gameType,
      message: 'Subscribed to live leaderboard updates'
    });
  });
  
  // Unsubscribe from live leaderboard updates
  socket.on('unsubscribe-leaderboard-updates', (data) => {
    const { gameType = 'all' } = data;
    
    // Leave leaderboard update room
    socket.leave(`leaderboard-${gameType}`);
    
    socket.emit('unsubscribed-from-leaderboard', {
      gameType: gameType,
      message: 'Unsubscribed from live leaderboard updates'
    });
  });
};

// Helper function to check for achievements
async function checkAchievements(userId, userData, db) {
  const newAchievements = [];
  const currentAchievements = userData.achievements || [];
  
  // Score milestones
  const scoreMilestones = [
    { score: 100, name: 'First Century', description: 'Reached 100 points' },
    { score: 500, name: 'Rising Star', description: 'Reached 500 points' },
    { score: 1000, name: 'Champion', description: 'Reached 1000 points' },
    { score: 5000, name: 'Legend', description: 'Reached 5000 points' },
    { score: 10000, name: 'Grandmaster', description: 'Reached 10,000 points' }
  ];
  
  for (const milestone of scoreMilestones) {
    if (userData.totalScore >= milestone.score && 
        !currentAchievements.some(a => a.name === milestone.name)) {
      newAchievements.push({
        ...milestone,
        unlockedAt: new Date(),
        type: 'score_milestone'
      });
    }
  }
  
  // Games played milestones
  const gamesMilestones = [
    { games: 10, name: 'Getting Started', description: 'Played 10 games' },
    { games: 50, name: 'Regular Player', description: 'Played 50 games' },
    { games: 100, name: 'Dedicated Gamer', description: 'Played 100 games' },
    { games: 500, name: 'Veteran', description: 'Played 500 games' }
  ];
  
  for (const milestone of gamesMilestones) {
    if (userData.gamesPlayed >= milestone.games && 
        !currentAchievements.some(a => a.name === milestone.name)) {
      newAchievements.push({
        ...milestone,
        unlockedAt: new Date(),
        type: 'games_milestone'
      });
    }
  }
  
  // Win streak achievements (would need additional tracking)
  const wins = userData.wins || 0;
  const winRate = userData.gamesPlayed > 0 ? wins / userData.gamesPlayed : 0;
  
  if (winRate >= 0.8 && userData.gamesPlayed >= 20 && 
      !currentAchievements.some(a => a.name === 'Dominator')) {
    newAchievements.push({
      name: 'Dominator',
      description: '80% win rate with 20+ games',
      unlockedAt: new Date(),
      type: 'performance'
    });
  }
  
  return newAchievements;
}

// Helper function to get time limit for timeframe filtering
function getTimeLimit(timeframe) {
  const now = new Date();
  const timeLimit = new Date();
  
  switch (timeframe) {
    case 'today':
      timeLimit.setHours(0, 0, 0, 0);
      break;
    case 'week':
      timeLimit.setDate(now.getDate() - 7);
      break;
    case 'month':
      timeLimit.setMonth(now.getMonth() - 1);
      break;
    case 'year':
      timeLimit.setFullYear(now.getFullYear() - 1);
      break;
    default:
      return null;
  }
  
  return timeLimit;
}