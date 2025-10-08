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
  // --- Getting Started ---
  {
    achievementId: "first_game",
    name: "Off the Blocks",
    description: "Play your very first game",
    icon: "Gamepad2",
    points: 5,
    rarity: "common",
    category: "progression",
    criteria: { type: "games_played", target: 1, metric: null }
  },
  {
    achievementId: "first_win",
    name: "First Victory",
    description: "Win your first game",
    icon: "Trophy",
    points: 10,
    rarity: "common",
    category: "progression",
    criteria: { type: "wins", target: 1, metric: null }
  },
  {
    achievementId: "point_accumulator",
    name: "Point Accumulator",
    description: "Reach a total score of 1,000",
    icon: "TrendingUp",
    points: 15,
    rarity: "common",
    category: "performance",
    criteria: { type: "total_score", target: 1000, metric: null }
  },
  {
    achievementId: "first_friend",
    name: "Friendly Coder",
    description: "Add your first friend",
    icon: "UserPlus",
    points: 10,
    rarity: "common",
    category: "social",
    criteria: { type: "friends", target: 1, metric: null }
  },

  // --- Skill & Performance ---
  {
    achievementId: "heating_up",
    name: "Heating Up",
    description: "Achieve a 5-game win streak",
    icon: "Flame",
    points: 50,
    rarity: "rare",
    category: "performance",
    criteria: { type: "win_streak", target: 5, metric: null }
  },
  {
    achievementId: "unstoppable_force",
    name: "Unstoppable Force",
    description: "Achieve a 10-game win streak",
    icon: "Rocket",
    points: 150,
    rarity: "epic",
    category: "performance",
    criteria: { type: "win_streak", target: 10, metric: null }
  },
  {
    achievementId: "perfect_start",
    name: "Perfect Start",
    description: "Achieve your first perfect score",
    icon: "Gem",
    points: 60,
    rarity: "rare",
    category: "performance",
    criteria: { type: "perfect_score", target: 1, metric: null }
  },
  {
    achievementId: "flawless_master",
    name: "Flawless Master",
    description: "Achieve 10 perfect scores",
    icon: "Crown",
    points: 180,
    rarity: "epic",
    category: "performance",
    criteria: { type: "perfect_score", target: 10, metric: null }
  },
  {
    achievementId: "high_scorer",
    name: "High Scorer",
    description: "Reach a total score of 25,000",
    icon: "Sigma",
    points: 100,
    rarity: "rare",
    category: "performance",
    criteria: { type: "total_score", target: 25000, metric: null }
  },
  {
    achievementId: "score_legend",
    name: "Score Legend",
    description: "Reach a total score of 100,000",
    icon: "Award",
    points: 250,
    rarity: "epic",
    category: "performance",
    criteria: { type: "total_score", target: 100000, metric: null }
  },

  // --- Consistency ---
  {
    achievementId: "consistent_coder",
    name: "Consistent Coder",
    description: "Log in for 3 consecutive days",
    icon: "CalendarDays",
    points: 20,
    rarity: "common",
    category: "consistency",
    criteria: { type: "daily_streak", target: 3, metric: null }
  },
  {
    achievementId: "weekly_habit",
    name: "Weekly Habit",
    description: "Maintain a 7-day login streak",
    icon: "CalendarCheck",
    points: 70,
    rarity: "rare",
    category: "consistency",
    criteria: { type: "daily_streak", target: 7, metric: null }
  },
  {
    achievementId: "dedicated_soul",
    name: "Dedicated Soul",
    description: "Maintain a 30-day login streak",
    icon: "CalendarHeart",
    points: 200,
    rarity: "epic",
    category: "consistency",
    criteria: { type: "daily_streak", target: 30, metric: null }
  },

  // --- Social ---
  {
    achievementId: "squad_goals",
    name: "Squad Goals",
    description: "Build a friend list of 10 people",
    icon: "Users",
    points: 40,
    rarity: "rare",
    category: "social",
    criteria: { type: "friends", target: 10, metric: null }
  },
  {
    achievementId: "community_pillar",
    name: "Community Pillar",
    description: "Build a friend list of 25 people",
    icon: "Network",
    points: 100,
    rarity: "epic",
    category: "social",
    criteria: { type: "friends", target: 25, metric: null }
  },
  
  // --- Game Mastery ---
  {
    achievementId: "battle_adept",
    name: "Battle Adept",
    description: "Score 5,000 points in 'coding-battle'",
    icon: "Swords",
    points: 80,
    rarity: "rare",
    category: "mastery",
    criteria: { type: "game_type_mastery", target: 5000, metric: "coding-battle" }
  },
  {
    achievementId: "battle_sentinel",
    name: "Battle Sentinel",
    description: "Score 15,000 points in 'coding-battle'",
    icon: "Shield",
    points: 160,
    rarity: "epic",
    category: "mastery",
    criteria: { type: "game_type_mastery", target: 15000, metric: "coding-battle" }
  },
  {
    achievementId: "quiz_prodigy",
    name: "Quiz Prodigy",
    description: "Score 5,000 points in 'quiz'",
    icon: "BrainCircuit",
    points: 80,
    rarity: "rare",
    category: "mastery",
    criteria: { type: "game_type_mastery", target: 5000, metric: "quiz" }
  },
  {
    achievementId: "debugger_detective",
    name: "Debugger Detective",
    description: "Score 5,000 points in 'debugger-challenge'",
    icon: "Bug",
    points: 80,
    rarity: "rare",
    category: "mastery",
    criteria: { type: "game_type_mastery", target: 5000, metric: "debugger-challenge" }
  },

  // --- Veteran Milestones ---
  {
    achievementId: "veteran_player",
    name: "Veteran Player",
    description: "Play a total of 250 games",
    icon: "Milestone",
    points: 125,
    rarity: "rare",
    category: "progression",
    criteria: { type: "games_played", target: 250, metric: null }
  },
  {
    achievementId: "marathon_runner",
    name: "Marathon Runner",
    description: "Play a total of 500 games",
    icon: "Footprints",
    points: 250,
    rarity: "epic",
    category: "progression",
    criteria: { type: "games_played", target: 500, metric: null }
  },
  {
    achievementId: "decorated_winner",
    name: "Decorated Winner",
    description: "Achieve 100 total wins",
    icon: "Medal",
    points: 200,
    rarity: "epic",
    category: "progression",
    criteria: { type: "wins", target: 100, metric: null }
  },
  {
    achievementId: "invincible",
    name: "Invincible",
    description: "Achieve an incredible 20-game win streak",
    icon: "ShieldCheck",
    points: 400,
    rarity: "legendary",
    category: "performance",
    criteria: { type: "win_streak", target: 20, metric: null }
  },
  {
    achievementId: "cosmic_scorer",
    name: "Cosmic Scorer",
    description: "Amass a galactic total of 500,000 points",
    icon: "Sparkles",
    points: 500,
    rarity: "legendary",
    category: "performance",
    criteria: { type: "total_score", target: 500000, metric: null }
  },
   {
    achievementId: "the_limit",
    name: "The Limit",
    description: "Play 1,000 games",
    icon: "Infinity",
    points: 500,
    rarity: "legendary",
    category: "progression",
    criteria: { type: "games_played", target: 1000, metric: null }
  },
  // --- Intermediate Milestones ---
  {
    achievementId: "games_played_25",
    name: "Getting Comfortable",
    description: "Play a total of 25 games",
    icon: "Dice5",
    points: 20,
    rarity: "common",
    category: "progression",
    criteria: { type: "games_played", target: 25, metric: null }
  },
  {
    achievementId: "wins_25",
    name: "Proven Winner",
    description: "Achieve 25 total wins",
    icon: "BadgeCheck",
    points: 40,
    rarity: "common",
    category: "progression",
    criteria: { type: "wins", target: 25, metric: null }
  },
  {
    achievementId: "score_5k",
    name: "Climbing the Ranks",
    description: "Reach a total score of 5,000",
    icon: "LineChart",
    points: 25,
    rarity: "common",
    category: "performance",
    criteria: { type: "total_score", target: 5000, metric: null }
  },
  {
    achievementId: "win_streak_2",
    name: "Back-to-Back",
    description: "Win 2 games in a row",
    icon: "Copy",
    points: 15,
    rarity: "common",
    category: "performance",
    criteria: { type: "win_streak", target: 2, metric: null }
  },
  {
    achievementId: "perfect_trifecta",
    name: "Trifecta",
    description: "Achieve 3 perfect scores",
    icon: "GalleryThumbnails",
    points: 90,
    rarity: "rare",
    category: "performance",
    criteria: { type: "perfect_score", target: 3, metric: null }
  },
  {
    achievementId: "inner_circle",
    name: "Inner Circle",
    description: "Build a friend list of 5 people",
    icon: "HeartHandshake",
    points: 20,
    rarity: "common",
    category: "social",
    criteria: { type: "friends", target: 5, metric: null }
  },
  {
    achievementId: "daily_streak_14",
    name: "Fortnight Follower",
    description: "Maintain a 14-day login streak",
    icon: "CalendarRange",
    points: 100,
    rarity: "rare",
    category: "consistency",
    criteria: { type: "daily_streak", target: 14, metric: null }
  },
  
  // --- Advanced Tiers ---
  {
    achievementId: "games_played_750",
    name: "True Dedication",
    description: "Play a total of 750 games",
    icon: "Component",
    points: 350,
    rarity: "epic",
    category: "progression",
    criteria: { type: "games_played", target: 750, metric: null }
  },
  {
    achievementId: "wins_250",
    name: "Victory Incarnate",
    description: "Achieve 250 total wins",
    icon: "Diamond",
    points: 300,
    rarity: "epic",
    category: "progression",
    criteria: { type: "wins", target: 250, metric: null }
  },
  {
    achievementId: "score_250k",
    name: "Quarter Million Club",
    description: "Reach a total score of 250,000",
    icon: "AreaChart",
    points: 350,
    rarity: "epic",
    category: "performance",
    criteria: { type: "total_score", target: 250000, metric: null }
  },
  {
    achievementId: "perfect_idealist",
    name: "The Idealist",
    description: "Achieve 25 perfect scores",
    icon: "Sparkle",
    points: 300,
    rarity: "epic",
    category: "performance",
    criteria: { type: "perfect_score", target: 25, metric: null }
  },
  {
    achievementId: "the_socialite",
    name: "The Socialite",
    description: "Build a friend list of 50 people",
    icon: "Globe",
    points: 150,
    rarity: "epic",
    category: "social",
    criteria: { type: "friends", target: 50, metric: null }
  },

  // --- Game Mode Specialists ---
  {
    achievementId: "bug_squasher",
    name: "Bug Squasher",
    description: "Score 1,000 points in 'debugger-challenge'",
    icon: "Hammer",
    points: 30,
    rarity: "common",
    category: "mastery",
    criteria: { type: "game_type_mastery", target: 1000, metric: "debugger-challenge" }
  },
  {
    achievementId: "chief_exterminator",
    name: "Chief Exterminator",
    description: "Score 10,000 points in 'debugger-challenge'",
    icon: "Construction",
    points: 100,
    rarity: "rare",
    category: "mastery",
    criteria: { type: "game_type_mastery", target: 10000, metric: "debugger-challenge" }
  },
  {
    achievementId: "quiz_mastermind",
    name: "Quiz Mastermind",
    description: "Score 10,000 points in 'quiz'",
    icon: "BrainCog",
    points: 100,
    rarity: "rare",
    category: "mastery",
    criteria: { type: "game_type_mastery", target: 10000, metric: "quiz" }
  },
  {
    achievementId: "battle_legend",
    name: "Battle Legend",
    description: "Score 25,000 points in 'coding-battle'",
    icon: "GanttChartSquare",
    points: 200,
    rarity: "epic",
    category: "mastery",
    criteria: { type: "game_type_mastery", target: 25000, metric: "coding-battle" }
  },

  // --- Legendary Goals ---
  {
    achievementId: "wins_500",
    name: "Grand Champion",
    description: "Achieve an astounding 500 wins",
    icon: "Atom",
    points: 600,
    rarity: "legendary",
    category: "progression",
    criteria: { type: "wins", target: 500, metric: null }
  },
  {
    achievementId: "score_millionaire",
    name: "Score Millionaire",
    description: "Reach the incredible 1,000,000 total score mark",
    icon: "Orbit",
    points: 1000,
    rarity: "legendary",
    category: "performance",
    criteria: { type: "total_score", target: 1000000, metric: null }
  },
  {
    achievementId: "seasonal_veteran",
    name: "Seasonal Veteran",
    description: "Maintain a 90-day login streak",
    icon: "SunMoon",
    points: 400,
    rarity: "legendary",
    category: "consistency",
    criteria: { type: "daily_streak", target: 90, metric: null }
  },
  {
    achievementId: "perfect_paragon",
    name: "Perfect Paragon",
    description: "Achieve 50 perfect scores",
    icon: "BadgeCent",
    points: 500,
    rarity: "legendary",
    category: "performance",
    criteria: { type: "perfect_score", target: 50, metric: null }
  }
];

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