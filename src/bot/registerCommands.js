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
          { name: 'Port Authority (bridges/tunnels/PATH)', value: 'panynj' }
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
        required: true,
        autocomplete: true
      },
      {
        name: 'permit_type',
        type: 3,
        description: 'Your permit class',
        required: false,
        choices: [
          { name: 'Commuter', value: 'commuter' },
          { name: 'Resident', value: 'resident' }
        ]
      },
      {
        name: 'home_campus',
        type: 3,
        description: 'The campus your permit is registered to',
        required: false,
        choices: [
          { name: 'Busch', value: 'Busch' },
          { name: 'Livingston', value: 'Livingston' },
          { name: 'College Ave', value: 'College Ave' },
          { name: 'Cook', value: 'Cook' },
          { name: 'Douglass', value: 'Douglass' }
        ]
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
    name: 'leavenow',
    description: 'Find out when to leave to arrive at a Rutgers building on time',
    options: [
      {
        name: 'destination',
        type: 3,
        description: 'Building you need to get to (e.g. Hill Center, Tillett Hall)',
        required: true,
        autocomplete: true
      },
      {
        name: 'arrival_time',
        type: 3,
        description: 'When do you need to arrive? (e.g. 9:00am, 14:30)',
        required: true
      },
      {
        name: 'from',
        type: 3,
        description: 'Where are you coming from? (e.g. 123 Main St, Edison NJ)',
        required: false
      },
      {
        name: 'home_campus',
        type: 3,
        description: 'Your home campus — used if "from" is not provided',
        required: false,
        choices: [
          { name: 'Busch', value: 'Busch' },
          { name: 'Livingston', value: 'Livingston' },
          { name: 'College Ave', value: 'College Ave' },
          { name: 'Cook', value: 'Cook' },
          { name: 'Douglass', value: 'Douglass' }
        ]
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