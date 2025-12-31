import { Command } from 'commander';
import inquirer from 'inquirer';
import { addMapping, getConfig, removeMapping, saveConfig, updateTwitterConfig } from './config-manager.js';

const program = new Command();

program
  .name('tweets-2-bsky-cli')
  .description('CLI to manage Twitter to Bluesky crossposting mappings')
  .version('1.0.0');

program
  .command('setup-twitter')
  .description('Setup Twitter auth cookies')
  .action(async () => {
    const config = getConfig();
    const answers = await inquirer.prompt([
      {
        type: 'input',
        name: 'authToken',
        message: 'Enter Twitter auth_token:',
        default: config.twitter.authToken,
      },
      {
        type: 'input',
        name: 'ct0',
        message: 'Enter Twitter ct0:',
        default: config.twitter.ct0,
      },
    ]);
    updateTwitterConfig(answers);
    console.log('Twitter config updated!');
  });

program
  .command('add-mapping')
  .description('Add a new Twitter to Bluesky mapping')
  .action(async () => {
    const answers = await inquirer.prompt([
      {
        type: 'input',
        name: 'twitterUsername',
        message: 'Twitter username to watch (without @):',
      },
      {
        type: 'input',
        name: 'bskyIdentifier',
        message: 'Bluesky identifier (handle or email):',
      },
      {
        type: 'password',
        name: 'bskyPassword',
        message: 'Bluesky app password:',
      },
      {
        type: 'input',
        name: 'bskyServiceUrl',
        message: 'Bluesky service URL:',
        default: 'https://bsky.social',
      },
    ]);
    addMapping(answers);
    console.log('Mapping added successfully!');
  });

program
  .command('list')
  .description('List all mappings')
  .action(() => {
    const config = getConfig();
    if (config.mappings.length === 0) {
      console.log('No mappings found.');
      return;
    }
    console.table(
      config.mappings.map((m) => ({
        id: m.id,
        twitter: m.twitterUsername,
        bsky: m.bskyIdentifier,
        enabled: m.enabled,
      })),
    );
  });

program
  .command('remove')
  .description('Remove a mapping')
  .action(async () => {
    const config = getConfig();
    if (config.mappings.length === 0) {
      console.log('No mappings to remove.');
      return;
    }
    const { id } = await inquirer.prompt([
      {
        type: 'list',
        name: 'id',
        message: 'Select a mapping to remove:',
        choices: config.mappings.map((m) => ({
          name: `${m.twitterUsername} -> ${m.bskyIdentifier}`,
          value: m.id,
        })),
      },
    ]);
    removeMapping(id);
    console.log('Mapping removed.');
  });

program
  .command('import-history')
  .description('Import history for a specific mapping')
  .action(async () => {
    const config = getConfig();
    if (config.mappings.length === 0) {
      console.log('No mappings found.');
      return;
    }
    const { id } = await inquirer.prompt([
      {
        type: 'list',
        name: 'id',
        message: 'Select a mapping to import history for:',
        choices: config.mappings.map((m) => ({
          name: `${m.twitterUsername} -> ${m.bskyIdentifier}`,
          value: m.id,
        })),
      },
    ]);

    const mapping = config.mappings.find((m) => m.id === id);
    if (!mapping) return;

    console.log(`
To import history for ${mapping.twitterUsername}, run:`);
    console.log(`  npm run import -- --username ${mapping.twitterUsername}`);
    console.log(`
You can also use additional flags:`);
    console.log('  --limit <number>  Limit the number of tweets to import');
    console.log('  --dry-run         Fetch and show tweets without posting');
    console.log(`
Example:`);
    console.log(`  npm run import -- --username ${mapping.twitterUsername} --limit 10 --dry-run
`);
  });

program
  .command('set-interval')
  .description('Set check interval in minutes')
  .argument('<minutes>', 'Interval in minutes')
  .action((minutes) => {
    const config = getConfig();
    config.checkIntervalMinutes = Number.parseInt(minutes, 10);
    saveConfig(config);
    console.log(`Interval set to ${minutes} minutes.`);
  });

program.parse();
