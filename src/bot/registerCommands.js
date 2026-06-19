require('dotenv').config();
const { REST, Routes } = require('discord.js');
const logger = require('../utils/logger');

const commands = [
  {
    name: 'transit',
    description: 'Get NJ Transit train and bus schedules to/from Rutgers',
    options: [
      {
        name: 'destination',
        type: 3,
        description: 'Where are you going? (e.g. NYC Penn Station, Trenton, Newark)',
        required: true
      },
      {
        name: 'time',
        type: 3,
        description: 'What time? (e.g. "now", "3:30pm") — defaults to now',
        required: false
      }
    ]
  },
  {
  name: 'alerts',
  description: 'Check live traffic alerts across NJ roadways and transit facilities',
  options: [
    {
      name: 'roadway',
      type: 3,
      description: 'Which roadway or facility to check',
      required: true,
      choices: [
        { name: 'NJ Turnpike', value: 'turnpike' },
        { name: 'Garden State Parkway', value: 'gsp' },
        { name: 'Turnpike + Parkway (both)', value: 'all' },
        { name: 'Atlantic City Expressway', value: 'ace' },
        { name: 'Port Authority (bridges/tunnels/PATH)', value: 'panynj' },
      ]
    }
  ]
},
  {
    name: 'access',
    description: 'Find accessible routes, entrances, and transportation options',
    options: [
      {
        name: 'destination',
        type: 3,
        description: 'Which building or location? (e.g. Hill Center, Busch Student Center)',
        required: true
      },
      {
        name: 'need',
        type: 3,
        description: 'Specific need (e.g. elevator, ramp, accessible parking)',
        required: false
      }
    ]
  },
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