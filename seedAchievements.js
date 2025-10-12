const admin = require('firebase-admin');
require('dotenv').config();

// Initialize Firebase Admin SDK
const serviceAccount = {
  "type": "service_account",
  "project_id": process.env.FIREBASE_PROJECT_ID,
  "private_key_id": "e85b67891e953125eb9ec955aedc4bc6675c76b5", //"abf65a4d1db28db8f606d36abd0ac7ebde8974f4"
  "private_key": process.env.FIREBASE_PRIVATE_KEY,
  "client_email": process.env.FIREBASE_CLIENT_EMAIL,
  "client_id": "118217008912100827596", // 117581257007229392200
  "auth_uri": "https://accounts.google.com/o/oauth2/auth",
  "token_uri": "https://oauth2.googleapis.com/token",
  "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
  "client_x509_cert_url": "https://www.googleapis.com/robot/v1/metadata/x509/firebase-adminsdk-fbsvc%40dev-battle-8b5b4.iam.gserviceaccount.com", //https://www.googleapis.com/robot/v1/metadata/x509/firebase-adminsdk-fbsvc%40dev-battle-e8b3f.iam.gserviceaccount.com
  "universe_domain": "googleapis.com"
}; 

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DATABASE_URL
});

const db = admin.firestore();


const achievements = [
  {
    "achievementId": "games_played_100",
    "name": "Centurion",
    "description": "Play a total of 100 games",
    "icon": "Shield",
    "points": 500,
    "rarity": "rare",
    "category": "progression",
    "criteria": { "type": "games_played", "target": 100, "metric": null }
  },
  {
    "achievementId": "wins_50",
    "name": "Seasoned Victor",
    "description": "Achieve 50 total wins",
    "icon": "Star",
    "points": 800,
    "rarity": "rare",
    "category": "progression",
    "criteria": { "type": "wins", "target": 50, "metric": null }
  },
  {
    "achievementId": "score_50k",
    "name": "Elite Scorer",
    "description": "Reach a total score of 50,000",
    "icon": "BarChartBig",
    "points": 1500,
    "rarity": "rare",
    "category": "performance",
    "criteria": { "type": "total_score", "target": 50000, "metric": null }
  },
  {
    "achievementId": "win_streak_15",
    "name": "Dominator",
    "description": "Achieve an impressive 15-game win streak",
    "icon": "Zap",
    "points": 2500,
    "rarity": "epic",
    "category": "performance",
    "criteria": { "type": "win_streak", "target": 15, "metric": null }
  },
  {
    "achievementId": "five_star_general",
    "name": "Five-Star General",
    "description": "Achieve 5 perfect scores",
    "icon": "StarHalf",
    "points": 1200,
    "rarity": "rare",
    "category": "performance",
    "criteria": { "type": "perfect_score", "target": 5, "metric": null }
  },
  {
    "achievementId": "daily_streak_60",
    "name": "Unwavering Devotion",
    "description": "Maintain a 60-day login streak",
    "icon": "CalendarClock",
    "points": 3000,
    "rarity": "epic",
    "category": "consistency",
    "criteria": { "type": "daily_streak", "target": 60, "metric": null }
  },
  {
    "achievementId": "network_nexus",
    "name": "Network Nexus",
    "description": "Build a massive friend list of 100 people",
    "icon": "TowerControl",
    "points": 2500,
    "rarity": "legendary",
    "category": "social",
    "criteria": { "type": "friends", "target": 100, "metric": null }
  },
  {
    "achievementId": "quiz_oracle",
    "name": "Quiz Oracle",
    "description": "Score 25,000 points in 'quiz'",
    "icon": "Lightbulb",
    "points": 2000,
    "rarity": "epic",
    "category": "mastery",
    "criteria": { "type": "game_type_mastery", "target": 25000, "metric": "quiz" }
  },
  {
    "achievementId": "syntax_surgeon",
    "name": "Syntax Surgeon",
    "description": "Score 25,000 points in 'debugger-challenge'",
    "icon": "Scissors",
    "points": 2000,
    "rarity": "epic",
    "category": "mastery",
    "criteria": { "type": "game_type_mastery", "target": 25000, "metric": "debugger-challenge" }
  },
  {
    "achievementId": "arena_gladiator",
    "name": "Arena Gladiator",
    "description": "Score 50,000 points in 'coding-battle'",
    "icon": "Landmark",
    "points": 3500,
    "rarity": "legendary",
    "category": "mastery",
    "criteria": { "type": "game_type_mastery", "target": 50000, "metric": "coding-battle" }
  },
  {
    "achievementId": "trophy_collector",
    "name": "Trophy Collector",
    "description": "Unlock a total of 15 achievements",
    "icon": "Target",
    "points": 1000,
    "rarity": "rare",
    "category": "progression",
    "criteria": { "type": "achievements_unlocked", "target": 15, "metric": null }
  },
  {
    "achievementId": "living_legend",
    "name": "Living Legend",
    "description": "Unlock a total of 40 achievements",
    "icon": "BookUser",
    "points": 4000,
    "rarity": "epic",
    "category": "progression",
    "criteria": { "type": "achievements_unlocked", "target": 40, "metric": null }
  }
]

async function seedAchievements() {
  try {
    console.log('🌱 Seeding achievements...');
    
    const batch = db.batch();
    
    for (const achievement of achievements) {
      const docRef = db.collection('achievements').doc();
      batch.set(docRef, {
        ...achievement,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }
    
    await batch.commit();
    
    console.log(`✅ Successfully added ${achievements.length} achievements!`);
    process.exit(0);
  } catch (error) {
    console.error('❌ Error seeding achievements:', error);
    process.exit(1);
  }
}

seedAchievements();