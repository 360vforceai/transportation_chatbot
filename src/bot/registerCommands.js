require('dotenv').config();
const { REST, Routes } = require('discord.js');
const logger = require('../utils/logger');

const commands = [
  {
    name: 'ask',
    description: 'Ask anything about Rutgers transportation',
    options: [
      {
        name: 'question',
        type: 3,
        description: 'Your question',
        required: true
      }
    ]
  },
  {
    name: 'parking',
    description: 'Find nearby parking lots, permit eligibility, and walking distance',
    options: [
      {
        name: 'destination',
        type: 3,
        description: 'Building or location you are headed to',
        required: true
      },
      {
        name: 'permit',
        type: 3,
        description: 'Your permit type (e.g. A, B, L, Commuter)',
        required: false
      },
      {
        name: 'time',
        type: 3,
        description: 'Time you plan to park, 24hr format e.g. 14:30 (defaults to now)',
        required: false
      }
    ]
  },
  {
    name: 'help',
    description: 'Show all available commands',
    options: []
  }
];

async function registerCommands() {
  const token = process.env.DISCORD_TOKEN;
  const appId = process.env.DISCORD_APP_ID;

  if (!token) {
    logger.error('DISCORD_TOKEN is not set');
    process.exit(1);
  }
  if (!appId) {
    logger.error('DISCORD_APP_ID is not set');
    process.exit(1);
  }

  console.log('Token exists:', !!token);
  console.log('Token length:', token?.length);
  console.log('App ID:', appId);

  const rest = new REST({ version: '10' }).setToken(token);

  try {
    logger.info('Registering slash commands...');
    const data = await rest.put(Routes.applicationCommands(appId), {
      body: commands
    });
    logger.info('Successfully registered', data.length, 'command(s)');
    process.exit(0);
  } catch (err) {
    logger.error('Failed to register commands:', err.message);
    process.exit(1);
  }
}

registerCommands();