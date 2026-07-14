import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import inquirer from 'inquirer';
import { deleteAllPosts } from './bsky.js';
import {
  type AccountMapping,
  type AppConfig,
  addMapping,
  getConfig,
  removeMapping,
  saveConfig,
  updateTwitterConfig,
} from './config-manager.js';
import { dbService, postQueueService } from './db.js';
import {
  PDS_DEFAULT_PORT,
  type PdsHandle,
  generateMissingPdsSecrets,
  isPdsHealthy,
  provisionPdsAccount,
  startPds,
  twitterHandleToPdsLabel,
  writeCaddyfile,
} from './pds-manager.js';
import {
  applyProfileMirrorSyncState,
  ensureBlueskyBotSelfLabel,
  fetchTwitterMirrorProfile,
  syncBlueskyProfileFromTwitter,
  validateBlueskyCredentials,
} from './profile-mirror.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.join(__dirname, '..');

const normalizeHandle = (value: string) => value.trim().replace(/^@/, '').toLowerCase();

const parsePositiveInt = (value: string, defaultValue: number): number => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return defaultValue;
  }
  return parsed;
};

const findMappingByRef = (config: AppConfig, ref: string): AccountMapping | undefined => {
  const needle = normalizeHandle(ref);
  return config.mappings.find(
    (mapping) =>
      mapping.id === ref ||
      normalizeHandle(mapping.bskyIdentifier) === needle ||
      mapping.twitterUsernames.some((username) => normalizeHandle(username) === needle),
  );
};

const selectMapping = async (message: string): Promise<AccountMapping | null> => {
  const config = getConfig();
  if (config.mappings.length === 0) {
    console.log('No mappings found.');
    return null;
  }

  const { id } = await inquirer.prompt([
    {
      type: 'list',
      name: 'id',
      message,
      choices: config.mappings.map((mapping) => ({
        name: `${mapping.owner || 'System'}: ${mapping.twitterUsernames.join(', ')} -> ${mapping.bskyIdentifier}`,
        value: mapping.id,
      })),
    },
  ]);

  return config.mappings.find((mapping) => mapping.id === id) ?? null;
};

const spawnAndWait = async (command: string, args: string[], cwd: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: 'inherit',
      env: process.env,
    });

    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Process exited with code ${code}`));
    });
  });

const runCoreCommand = async (args: string[]): Promise<void> => {
  const distEntry = path.join(ROOT_DIR, 'dist', 'index.js');
  if (fs.existsSync(distEntry)) {
    await spawnAndWait(process.execPath, [distEntry, ...args], ROOT_DIR);
    return;
  }

  const sourceEntry = path.join(ROOT_DIR, 'src', 'index.ts');
  if (fs.existsSync(sourceEntry)) {
    await spawnAndWait(process.execPath, [sourceEntry, ...args], ROOT_DIR);
    return;
  }

  throw new Error('Could not find dist/index.js or source runtime entry. Run bun run build first.');
};

const ensureMapping = async (mappingRef?: string): Promise<AccountMapping | null> => {
  const config = getConfig();
  if (config.mappings.length === 0) {
    console.log('No mappings found.');
    return null;
  }

  if (mappingRef) {
    const mapping = findMappingByRef(config, mappingRef);
    if (!mapping) {
      console.log(`No mapping found for '${mappingRef}'.`);
      return null;
    }
    return mapping;
  }

  return selectMapping('Select a mapping:');
};

const exportConfig = (outputFile: string) => {
  const config = getConfig();
  const { users, ...cleanConfig } = config;
  const outputPath = path.resolve(outputFile);
  fs.writeFileSync(outputPath, JSON.stringify(cleanConfig, null, 2));
  console.log(`Exported config to ${outputPath}.`);
};

const importConfig = (inputFile: string) => {
  const inputPath = path.resolve(inputFile);
  if (!fs.existsSync(inputPath)) {
    throw new Error(`File not found: ${inputPath}`);
  }

  const parsed = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  if (!parsed.mappings || !Array.isArray(parsed.mappings)) {
    throw new Error('Invalid config format: missing mappings array.');
  }

  const currentConfig = getConfig();
  const nextConfig: AppConfig = {
    ...currentConfig,
    mappings: parsed.mappings,
    groups: Array.isArray(parsed.groups) ? parsed.groups : currentConfig.groups,
    twitter: parsed.twitter || currentConfig.twitter,
    ai: parsed.ai || currentConfig.ai,
    checkIntervalMinutes: parsed.checkIntervalMinutes || currentConfig.checkIntervalMinutes,
  };

  saveConfig(nextConfig);
  console.log('Config imported successfully. Existing users were preserved.');
};

const program = new Command();

program.name('tweets-2-bsky-cli').description('CLI for full Tweets -> Bluesky dashboard workflows').version('2.1.0');

program
  .command('setup-ai')
  .description('Configure AI settings for alt text generation')
  .action(async () => {
    const config = getConfig();
    const currentAi = config.ai || { provider: 'gemini' };

    if (!config.ai && config.geminiApiKey) {
      currentAi.apiKey = config.geminiApiKey;
    }

    const answers = await inquirer.prompt([
      {
        type: 'list',
        name: 'provider',
        message: 'Select AI Provider:',
        choices: [
          { name: 'Google Gemini (Default)', value: 'gemini' },
          { name: 'OpenAI / OpenRouter', value: 'openai' },
          { name: 'Anthropic (Claude)', value: 'anthropic' },
          { name: 'Custom (OpenAI Compatible)', value: 'custom' },
        ],
        default: currentAi.provider,
      },
      {
        type: 'input',
        name: 'apiKey',
        message: 'Enter API Key (optional for some custom providers):',
        default: currentAi.apiKey,
      },
      {
        type: 'input',
        name: 'model',
        message: 'Enter Model ID (optional, leave empty for default):',
        default: currentAi.model,
      },
      {
        type: 'input',
        name: 'baseUrl',
        message: 'Enter Base URL (optional):',
        default: currentAi.baseUrl,
        when: (answers) => ['openai', 'anthropic', 'custom'].includes(answers.provider),
      },
    ]);

    config.ai = {
      provider: answers.provider,
      apiKey: answers.apiKey,
      model: answers.model || undefined,
      baseUrl: answers.baseUrl || undefined,
    };

    config.geminiApiKey = undefined; // legacy field; dropped from config.json on save
    saveConfig(config);
    console.log('AI configuration updated.');
  });

program
  .command('setup-twitter')
  .description('Setup Twitter auth cookies (primary + backup)')
  .action(async () => {
    const config = getConfig();
    const answers = await inquirer.prompt([
      {
        type: 'input',
        name: 'authToken',
        message: 'Primary Twitter auth_token:',
        default: config.twitter.authToken,
      },
      {
        type: 'input',
        name: 'ct0',
        message: 'Primary Twitter ct0:',
        default: config.twitter.ct0,
      },
      {
        type: 'input',
        name: 'backupAuthToken',
        message: 'Backup Twitter auth_token (optional):',
        default: config.twitter.backupAuthToken,
      },
      {
        type: 'input',
        name: 'backupCt0',
        message: 'Backup Twitter ct0 (optional):',
        default: config.twitter.backupCt0,
      },
    ]);

    updateTwitterConfig(answers);
    console.log('Twitter credentials updated.');
  });

program
  .command('add-mapping')
  .description('Add a new Twitter -> Bluesky mapping with guided onboarding')
  .action(async () => {
    const config = getConfig();
    const ownerDefault =
      config.users.find((user) => user.role === 'admin')?.username || config.users[0]?.username || '';

    const answers = await inquirer.prompt([
      {
        type: 'input',
        name: 'twitterUsernames',
        message: 'Twitter username(s) to watch (comma separated, without @):',
      },
    ]);

    const usernames = String(answers.twitterUsernames || '')
      .split(',')
      .map((username: string) => normalizeHandle(username))
      .filter((username: string) => username.length > 0);

    if (usernames.length === 0) {
      console.log('Please provide at least one Twitter username.');
      return;
    }

    const accountFlow = await inquirer.prompt([
      {
        type: 'list',
        name: 'accountState',
        message: 'Bluesky account setup:',
        choices: [
          { name: 'Open bsky.app and create a new account', value: 'create' },
          { name: 'I already have a Bluesky account', value: 'existing' },
        ],
      },
    ]);

    if (accountFlow.accountState === 'create') {
      console.log('Open https://bsky.app to create the account, then generate an app password.');
      const continueAnswer = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'continueAfterCreate',
          message: 'Continue once your Bluesky account exists?',
          default: true,
        },
      ]);

      if (!continueAnswer.continueAfterCreate) {
        console.log('Cancelled.');
        return;
      }
    }

    const bskyAnswers = await inquirer.prompt([
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

    let validation: Awaited<ReturnType<typeof validateBlueskyCredentials>>;
    try {
      validation = await validateBlueskyCredentials({
        bskyIdentifier: bskyAnswers.bskyIdentifier,
        bskyPassword: bskyAnswers.bskyPassword,
        bskyServiceUrl: bskyAnswers.bskyServiceUrl,
      });
      console.log(`Authenticated as @${validation.handle} on ${validation.serviceUrl}.`);
      if (validation.emailConfirmed) {
        console.log('Email status: confirmed ✅');
      } else {
        console.log('Email status: not confirmed yet ⚠️ (media upload features may be limited until verified).');
      }
      console.log(`Verify email from: ${validation.settingsUrl}`);
    } catch (error) {
      console.log(`Bluesky credential validation failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    const continueAfterVerify = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'continueAfterVerify',
        message: 'Continue with mapping creation and profile mirror sync now?',
        default: validation.emailConfirmed,
      },
    ]);

    if (!continueAfterVerify.continueAfterVerify) {
      console.log('Cancelled.');
      return;
    }

    try {
      const preview = await fetchTwitterMirrorProfile(usernames[0] || '');
      console.log(`Twitter mirror preview from @${preview.username}:`);
      console.log(`  Display name -> ${preview.mirroredDisplayName}`);
      console.log(`  Bio preview  -> ${JSON.stringify(preview.mirroredDescription)}`);
    } catch (error) {
      console.log(`Twitter metadata preview failed: ${error instanceof Error ? error.message : String(error)}`);
      console.log('Continuing. You can retry profile sync later with sync-profile.');
    }

    const metadataAnswers = await inquirer.prompt([
      {
        type: 'input',
        name: 'owner',
        message: 'Owner name (optional):',
        default: ownerDefault,
      },
      {
        type: 'input',
        name: 'groupName',
        message: 'Group/folder name (optional):',
      },
      {
        type: 'input',
        name: 'groupEmoji',
        message: 'Group emoji icon (optional):',
      },
      {
        type: 'list',
        name: 'mirrorSourceUsername',
        message: 'Use which Twitter source for profile mirror metadata?',
        choices: usernames.map((username) => ({
          name: `@${username}`,
          value: username,
        })),
        default: usernames[0],
      },
    ]);

    addMapping({
      owner: metadataAnswers.owner,
      twitterUsernames: usernames,
      bskyIdentifier: bskyAnswers.bskyIdentifier,
      bskyPassword: bskyAnswers.bskyPassword,
      bskyServiceUrl: bskyAnswers.bskyServiceUrl,
      groupName: metadataAnswers.groupName?.trim() || undefined,
      groupEmoji: metadataAnswers.groupEmoji?.trim() || undefined,
      profileSyncSourceUsername: normalizeHandle(metadataAnswers.mirrorSourceUsername || usernames[0] || ''),
    });

    const latestConfig = getConfig();
    const createdMapping = [...latestConfig.mappings]
      .reverse()
      .find(
        (mapping) =>
          normalizeHandle(mapping.bskyIdentifier) === normalizeHandle(bskyAnswers.bskyIdentifier) &&
          normalizeHandle(mapping.bskyServiceUrl || 'https://bsky.social') ===
            normalizeHandle(bskyAnswers.bskyServiceUrl || 'https://bsky.social') &&
          mapping.twitterUsernames.length === usernames.length &&
          mapping.twitterUsernames.every(
            (username, index) => normalizeHandle(username) === normalizeHandle(usernames[index] || ''),
          ),
      );

    if (!createdMapping) {
      console.log('Mapping added, but could not locate it for automatic profile sync.');
      return;
    }

    try {
      const botLabelResult = await ensureBlueskyBotSelfLabel({
        bskyIdentifier: createdMapping.bskyIdentifier,
        bskyPassword: createdMapping.bskyPassword,
        bskyServiceUrl: createdMapping.bskyServiceUrl,
      });
      const labeledConfig = getConfig();
      const labeledIndex = labeledConfig.mappings.findIndex((entry) => entry.id === createdMapping.id);
      if (labeledIndex !== -1) {
        const current = labeledConfig.mappings[labeledIndex];
        if (current && !current.hasBotLabel) {
          current.hasBotLabel = true;
          saveConfig(labeledConfig);
        }
      }
      if (botLabelResult.updated) {
        console.log('Applied Bluesky bot self-label.');
      } else {
        console.log('Bluesky bot self-label already present.');
      }
    } catch (error) {
      console.log(
        `Warning: failed to apply Bluesky bot self-label automatically: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    try {
      const syncResult = await syncBlueskyProfileFromTwitter({
        twitterUsername: metadataAnswers.mirrorSourceUsername,
        bskyIdentifier: createdMapping.bskyIdentifier,
        bskyPassword: createdMapping.bskyPassword,
        bskyServiceUrl: createdMapping.bskyServiceUrl,
        previousSync: {
          sourceUsername: createdMapping.profileSyncSourceUsername,
          mirroredDisplayName: createdMapping.lastMirroredDisplayName,
          mirroredDescription: createdMapping.lastMirroredDescription,
          avatarUrl: createdMapping.lastMirroredAvatarUrl,
          bannerUrl: createdMapping.lastMirroredBannerUrl,
        },
      });

      const syncedConfig = getConfig();
      const syncedIndex = syncedConfig.mappings.findIndex((entry) => entry.id === createdMapping.id);
      if (syncedIndex !== -1) {
        const current = syncedConfig.mappings[syncedIndex];
        if (current) {
          syncedConfig.mappings[syncedIndex] = applyProfileMirrorSyncState(
            current,
            metadataAnswers.mirrorSourceUsername,
            syncResult,
          );
          saveConfig(syncedConfig);
        }
      }

      console.log('Mapping added successfully. Bluesky profile mirror sync completed.');
      if (syncResult.skipped) {
        console.log('No profile updates were required (Twitter profile is unchanged).');
      }
      if (syncResult.warnings.length > 0) {
        console.log('Profile sync warnings:');
        for (const warning of syncResult.warnings) {
          console.log(`  - ${warning}`);
        }
      }
    } catch (error) {
      console.log('Mapping added successfully, but automatic profile sync failed.');
      console.log(`Reason: ${error instanceof Error ? error.message : String(error)}`);
      console.log('Run `bun run cli -- sync-profile` later to retry.');
    }
  });

program
  .command('sync-profile [mapping]')
  .description('Sync Bluesky profile from a mapped Twitter source')
  .option('-s, --source <username>', 'Twitter source username to mirror from')
  .action(async (mappingRef?: string, options?: { source?: string }) => {
    const mapping = await ensureMapping(mappingRef);
    if (!mapping) return;

    const availableSources = mapping.twitterUsernames.map(normalizeHandle).filter((username) => username.length > 0);
    const requestedSource = options?.source ? normalizeHandle(options.source) : '';
    if (requestedSource && !availableSources.includes(requestedSource)) {
      console.log(`@${requestedSource} is not part of the selected mapping.`);
      return;
    }

    const storedSource = normalizeHandle(mapping.profileSyncSourceUsername || '');
    const sourceTwitterUsername =
      requestedSource ||
      (storedSource && availableSources.includes(storedSource) ? storedSource : '') ||
      availableSources[0] ||
      '';

    if (!sourceTwitterUsername) {
      console.log('Mapping has no Twitter source usernames.');
      return;
    }

    try {
      const result = await syncBlueskyProfileFromTwitter({
        twitterUsername: sourceTwitterUsername,
        bskyIdentifier: mapping.bskyIdentifier,
        bskyPassword: mapping.bskyPassword,
        bskyServiceUrl: mapping.bskyServiceUrl,
        previousSync: {
          sourceUsername: mapping.profileSyncSourceUsername,
          mirroredDisplayName: mapping.lastMirroredDisplayName,
          mirroredDescription: mapping.lastMirroredDescription,
          avatarUrl: mapping.lastMirroredAvatarUrl,
          bannerUrl: mapping.lastMirroredBannerUrl,
        },
      });

      const config = getConfig();
      const index = config.mappings.findIndex((entry) => entry.id === mapping.id);
      if (index !== -1) {
        const current = config.mappings[index];
        if (current) {
          config.mappings[index] = applyProfileMirrorSyncState(current, sourceTwitterUsername, result);
          saveConfig(config);
        }
      }

      console.log(`Profile sync completed for ${mapping.bskyIdentifier} from @${result.twitterProfile.username}.`);
      if (result.skipped) {
        console.log('No profile updates needed (Twitter profile is unchanged).');
      }
      if (result.warnings.length > 0) {
        console.log('Warnings:');
        for (const warning of result.warnings) {
          console.log(`  - ${warning}`);
        }
      }
    } catch (error) {
      console.log(`Profile sync failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

program
  .command('edit-mapping [mapping]')
  .description('Edit a mapping by id/handle/twitter username')
  .action(async (mappingRef?: string) => {
    const mapping = await ensureMapping(mappingRef);
    if (!mapping) return;

    const config = getConfig();
    const answers = await inquirer.prompt([
      {
        type: 'input',
        name: 'owner',
        message: 'Owner:',
        default: mapping.owner || '',
      },
      {
        type: 'input',
        name: 'twitterUsernames',
        message: 'Twitter username(s) (comma separated):',
        default: mapping.twitterUsernames.join(', '),
      },
      {
        type: 'input',
        name: 'bskyIdentifier',
        message: 'Bluesky identifier:',
        default: mapping.bskyIdentifier,
      },
      {
        type: 'password',
        name: 'bskyPassword',
        message: 'Bluesky app password (leave empty to keep current):',
      },
      {
        type: 'input',
        name: 'bskyServiceUrl',
        message: 'Bluesky service URL:',
        default: mapping.bskyServiceUrl || 'https://bsky.social',
      },
      {
        type: 'input',
        name: 'groupName',
        message: 'Group/folder name (optional):',
        default: mapping.groupName || '',
      },
      {
        type: 'input',
        name: 'groupEmoji',
        message: 'Group emoji icon (optional):',
        default: mapping.groupEmoji || '',
      },
    ]);

    const usernames = answers.twitterUsernames
      .split(',')
      .map((username: string) => username.trim())
      .map((username: string) => normalizeHandle(username))
      .filter((username: string) => username.length > 0);

    if (usernames.length === 0) {
      console.log('Please provide at least one Twitter username.');
      return;
    }

    let profileSyncSourceUsername = normalizeHandle(mapping.profileSyncSourceUsername || '');
    if (usernames.length === 1) {
      profileSyncSourceUsername = usernames[0] || '';
    } else {
      const currentSource = usernames.includes(profileSyncSourceUsername)
        ? profileSyncSourceUsername
        : usernames[0] || '';
      const sourceAnswer = await inquirer.prompt([
        {
          type: 'list',
          name: 'profileSyncSourceUsername',
          message: 'Use which Twitter source for profile syncing?',
          choices: usernames.map((username: string) => ({
            name: `@${username}`,
            value: username,
          })),
          default: currentSource,
        },
      ]);
      profileSyncSourceUsername = normalizeHandle(String(sourceAnswer.profileSyncSourceUsername || ''));
    }

    const index = config.mappings.findIndex((entry) => entry.id === mapping.id);
    if (index === -1) return;

    const existingMapping = config.mappings[index];
    if (!existingMapping) return;

    const updatedMapping = {
      ...existingMapping,
      owner: answers.owner,
      twitterUsernames: usernames,
      bskyIdentifier: answers.bskyIdentifier,
      bskyServiceUrl: answers.bskyServiceUrl,
      groupName: answers.groupName?.trim() || undefined,
      groupEmoji: answers.groupEmoji?.trim() || undefined,
      profileSyncSourceUsername: profileSyncSourceUsername || undefined,
    };

    if (answers.bskyPassword && answers.bskyPassword.trim().length > 0) {
      updatedMapping.bskyPassword = answers.bskyPassword;
    }

    config.mappings[index] = updatedMapping;
    saveConfig(config);
    console.log('Mapping updated successfully.');
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
      config.mappings.map((mapping) => ({
        id: mapping.id,
        owner: mapping.owner || 'System',
        twitter: mapping.twitterUsernames.join(', '),
        profileSyncSource: mapping.profileSyncSourceUsername || '--',
        bsky: mapping.bskyIdentifier,
        group: `${mapping.groupEmoji || '📁'} ${mapping.groupName || 'Ungrouped'}`,
        enabled: mapping.enabled,
      })),
    );
  });

program
  .command('remove [mapping]')
  .description('Remove a mapping by id/handle/twitter username')
  .action(async (mappingRef?: string) => {
    const mapping = await ensureMapping(mappingRef);
    if (!mapping) return;

    const { confirmed } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirmed',
        message: `Remove mapping ${mapping.twitterUsernames.join(', ')} -> ${mapping.bskyIdentifier}?`,
        default: false,
      },
    ]);

    if (!confirmed) {
      console.log('Cancelled.');
      return;
    }

    removeMapping(mapping.id);
    console.log('Mapping removed.');
  });

program
  .command('import-history [mapping]')
  .description('Import history immediately for one mapping')
  .option('-l, --limit <number>', 'Tweet limit', '15')
  .option('--dry-run', 'Do not post to Bluesky', false)
  .option('--web', 'Keep web server enabled during import', false)
  .action(async (mappingRef: string | undefined, options) => {
    const mapping = await ensureMapping(mappingRef);
    if (!mapping) return;

    let username = mapping.twitterUsernames[0] ?? '';
    if (!username) {
      console.log('Mapping has no Twitter usernames.');
      return;
    }

    if (mapping.twitterUsernames.length > 1) {
      const answer = await inquirer.prompt([
        {
          type: 'list',
          name: 'username',
          message: 'Select Twitter username to import:',
          choices: mapping.twitterUsernames,
          default: username,
        },
      ]);
      username = String(answer.username || '').trim();
    }

    const args: string[] = [
      '--import-history',
      '--username',
      username,
      '--limit',
      String(parsePositiveInt(options.limit, 15)),
    ];
    if (options.dryRun) args.push('--dry-run');
    if (!options.web) args.push('--no-web');

    await runCoreCommand(args);
  });

program
  .command('set-interval <minutes>')
  .description('Set scheduler interval in minutes')
  .action((minutes) => {
    const parsed = parsePositiveInt(minutes, 5);
    const config = getConfig();
    config.checkIntervalMinutes = parsed;
    saveConfig(config);
    console.log(`Interval set to ${parsed} minutes.`);
  });

program
  .command('run-now')
  .description('Run one sync cycle now (ideal for cronjobs)')
  .option('--dry-run', 'Fetch but do not post', false)
  .option('--web', 'Keep web server enabled during this run', false)
  .action(async (options) => {
    const args = ['--run-once'];
    if (options.dryRun) args.push('--dry-run');
    if (!options.web) args.push('--no-web');
    await runCoreCommand(args);
  });

program
  .command('backfill [mapping]')
  .description('Run backfill now for one mapping (id/handle/twitter username)')
  .option('-l, --limit <number>', 'Tweet limit', '15')
  .option('--dry-run', 'Fetch but do not post', false)
  .option('--web', 'Keep web server enabled during this run', false)
  .action(async (mappingRef: string | undefined, options) => {
    const mapping = await ensureMapping(mappingRef);
    if (!mapping) return;

    const args = [
      '--run-once',
      '--backfill-mapping',
      mapping.id,
      '--backfill-limit',
      String(parsePositiveInt(options.limit, 15)),
    ];
    if (options.dryRun) args.push('--dry-run');
    if (!options.web) args.push('--no-web');

    await runCoreCommand(args);
  });

program
  .command('clear-cache [mapping]')
  .description('Clear cached tweet history for a mapping')
  .action(async (mappingRef?: string) => {
    const mapping = await ensureMapping(mappingRef);
    if (!mapping) return;

    for (const username of mapping.twitterUsernames) {
      dbService.deleteTweetsByUsername(username);
    }

    console.log(`Cache cleared for ${mapping.twitterUsernames.join(', ')}.`);
  });

program
  .command('delete-all-posts [mapping]')
  .description('Delete all posts on mapped Bluesky account and clear local cache')
  .action(async (mappingRef?: string) => {
    const mapping = await ensureMapping(mappingRef);
    if (!mapping) return;

    const { confirmed } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirmed',
        message: `Delete ALL posts for ${mapping.bskyIdentifier}? This cannot be undone.`,
        default: false,
      },
    ]);

    if (!confirmed) {
      console.log('Cancelled.');
      return;
    }

    const { typed } = await inquirer.prompt([
      {
        type: 'input',
        name: 'typed',
        message: 'Type DELETE to confirm:',
      },
    ]);

    if (typed !== 'DELETE') {
      console.log('Confirmation failed. Aborting.');
      return;
    }

    const deleted = await deleteAllPosts(mapping.id);
    dbService.deleteTweetsByBskyIdentifier(mapping.bskyIdentifier);
    console.log(`Deleted ${deleted} posts for ${mapping.bskyIdentifier} and cleared local cache.`);
  });

program
  .command('recent-activity')
  .description('Show recent processed tweets')
  .option('-l, --limit <number>', 'Number of rows', '20')
  .action((options) => {
    const limit = parsePositiveInt(options.limit, 20);
    const rows = dbService.getRecentProcessedTweets(limit);

    if (rows.length === 0) {
      console.log('No recent activity found.');
      return;
    }

    console.table(
      rows.map((row) => ({
        time: row.created_at,
        twitter: row.twitter_username,
        bsky: row.bsky_identifier,
        status: row.status,
        text: row.tweet_text ? row.tweet_text.slice(0, 80) : row.twitter_id,
      })),
    );
  });

program
  .command('config-export [file]')
  .description('Export dashboard config (without users/password hashes)')
  .action((file = 'tweets-2-bsky-config.json') => {
    exportConfig(file);
  });

program
  .command('config-import <file>')
  .description('Import dashboard config (preserves existing users)')
  .action((file) => {
    importConfig(file);
  });

program
  .command('status')
  .description('Show local CLI status summary')
  .action(async () => {
    const config = getConfig();
    const recent = dbService.getRecentProcessedTweets(5);

    if (config.pds?.hostname) {
      const healthy = config.pds.enabled && (await isPdsHealthy(`http://127.0.0.1:${config.pds.port}`));
      console.log(
        `Built-in PDS: ${config.pds.hostname}:${config.pds.port} (${config.pds.enabled ? (healthy ? 'running' : 'enabled, not running') : 'disabled'})`,
      );
    }

    console.log('Tweets-2-Bsky status');
    console.log('--------------------');
    console.log(`Mappings: ${config.mappings.length}`);
    console.log(`Enabled mappings: ${config.mappings.filter((mapping) => mapping.enabled).length}`);
    console.log(`Check interval: ${config.checkIntervalMinutes} minute(s)`);
    console.log(`Twitter configured: ${Boolean(config.twitter.authToken && config.twitter.ct0)}`);
    console.log(`AI provider: ${config.ai?.provider || 'gemini (default)'}`);
    console.log(`Recent processed tweets: ${recent.length > 0 ? recent.length : 0}`);

    const queue = postQueueService.getCounts();
    console.log(`Post queue: ${queue.pending} pending, ${queue.processing} posting, ${queue.failed} failed`);

    if (recent.length > 0) {
      const last = recent[0];
      console.log(`Latest activity: ${last?.created_at || 'unknown'} (${last?.status || 'unknown'})`);
    }
  });

// ---------------------------------------------------------------------------
// Built-in PDS mode
// ---------------------------------------------------------------------------

const stepLog = (message: string) => console.log(`   ↳ ${message}`);

const resolve4 = async (name: string): Promise<string[]> => {
  try {
    const { promises: dns } = await import('node:dns');
    return await dns.resolve4(name);
  } catch {
    return [];
  }
};

const isLocalPdsHostname = (hostname: string) =>
  hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.test');

async function checkPdsDnsSetup(hostname: string): Promise<boolean> {
  console.log('\nChecking DNS setup (best effort)...');
  let publicIp = '';
  try {
    const res = await fetch('https://api.ipify.org', { signal: AbortSignal.timeout(5_000) });
    publicIp = (await res.text()).trim();
    console.log(`   Public IP of this machine: ${publicIp}`);
  } catch {
    console.log('   Could not determine public IP (offline?). Skipping IP comparison.');
  }

  const rootRecords = await resolve4(hostname);
  const wildcardRecords = await resolve4(`t2b-dns-check-${Date.now().toString(36)}.${hostname}`);

  let ok = true;
  if (rootRecords.length === 0) {
    console.log(`   ✗ ${hostname} has no A record.`);
    ok = false;
  } else if (publicIp && !rootRecords.includes(publicIp)) {
    console.log(`   ✗ ${hostname} resolves to ${rootRecords.join(', ')} (not this machine).`);
    ok = false;
  } else {
    console.log(`   ✓ ${hostname} -> ${rootRecords.join(', ')}`);
  }

  if (wildcardRecords.length === 0) {
    console.log(`   ✗ Wildcard *.${hostname} does not resolve. Mirrored handles need it.`);
    ok = false;
  } else if (publicIp && !wildcardRecords.includes(publicIp)) {
    console.log(`   ✗ *.${hostname} resolves to ${wildcardRecords.join(', ')} (not this machine).`);
    ok = false;
  } else {
    console.log(`   ✓ *.${hostname} -> ${wildcardRecords.join(', ')}`);
  }

  if (!ok) {
    console.log('\n   Required DNS records (both pointing at this server):');
    console.log(`     A  ${hostname}      -> <public IP>`);
    console.log(`     A  *.${hostname}    -> <public IP>`);
  }
  return ok;
}

// Uses an already-running PDS (e.g. under `bun start`) when the port answers
// health checks; otherwise starts a temporary in-process instance.
async function ensurePdsForCli(settings: { enabled: boolean; hostname: string; port: number }): Promise<{
  tempHandle: PdsHandle | null;
}> {
  const localUrl = `http://127.0.0.1:${settings.port}`;
  if (await isPdsHealthy(localUrl)) {
    console.log(`Using already-running PDS at ${localUrl}.`);
    return { tempHandle: null };
  }
  console.log('Starting built-in PDS...');
  const tempHandle = await startPds(settings);
  console.log(`PDS ready at ${tempHandle.localUrl}.`);
  return { tempHandle };
}

async function mirrorTwitterAccountToPds(
  settings: { enabled: boolean; hostname: string; port: number },
  rawUsername: string,
  ownerDefault: string,
): Promise<AccountMapping | null> {
  const twitterUsername = normalizeHandle(rawUsername);
  const localUrl = `http://127.0.0.1:${settings.port}`;

  console.log(`\n@${twitterUsername} -> ${twitterHandleToPdsLabel(twitterUsername)}.${settings.hostname}`);

  const account = await provisionPdsAccount(settings, twitterUsername, stepLog);
  if (account.existing) {
    stepLog('Reusing existing PDS account (password was rotated).');
  }

  const existingMapping = findMappingByRef(getConfig(), account.handle);
  if (existingMapping) {
    stepLog('Updating existing mapping credentials');
    const config = getConfig();
    const index = config.mappings.findIndex((entry) => entry.id === existingMapping.id);
    const current = config.mappings[index];
    if (index !== -1 && current) {
      config.mappings[index] = {
        ...current,
        bskyPassword: account.password,
        bskyServiceUrl: localUrl,
        pdsManaged: true,
      };
      saveConfig(config);
    }
  } else {
    stepLog('Saving mapping');
    addMapping({
      owner: ownerDefault || undefined,
      twitterUsernames: [twitterUsername],
      bskyIdentifier: account.handle,
      bskyPassword: account.password,
      bskyServiceUrl: localUrl,
      profileSyncSourceUsername: twitterUsername,
      pdsManaged: true,
    });
  }

  const mapping = findMappingByRef(getConfig(), account.handle);
  if (!mapping) {
    console.log('   ✗ Mapping was saved but could not be found again; skipping profile sync.');
    return null;
  }

  try {
    stepLog('Applying Bluesky bot self-label');
    await ensureBlueskyBotSelfLabel({
      bskyIdentifier: mapping.bskyIdentifier,
      bskyPassword: mapping.bskyPassword,
      bskyServiceUrl: mapping.bskyServiceUrl,
    });
    const config = getConfig();
    const index = config.mappings.findIndex((entry) => entry.id === mapping.id);
    const current = config.mappings[index];
    if (index !== -1 && current && !current.hasBotLabel) {
      current.hasBotLabel = true;
      saveConfig(config);
    }
  } catch (error) {
    stepLog(`Bot self-label failed (non-fatal): ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    stepLog(`Mirroring profile from @${twitterUsername} (name, bio, avatar, banner)`);
    const syncResult = await syncBlueskyProfileFromTwitter({
      twitterUsername,
      bskyIdentifier: mapping.bskyIdentifier,
      bskyPassword: mapping.bskyPassword,
      bskyServiceUrl: mapping.bskyServiceUrl,
      previousSync: {
        sourceUsername: mapping.profileSyncSourceUsername,
        mirroredDisplayName: mapping.lastMirroredDisplayName,
        mirroredDescription: mapping.lastMirroredDescription,
        avatarUrl: mapping.lastMirroredAvatarUrl,
        bannerUrl: mapping.lastMirroredBannerUrl,
      },
    });
    const config = getConfig();
    const index = config.mappings.findIndex((entry) => entry.id === mapping.id);
    const current = config.mappings[index];
    if (index !== -1 && current) {
      config.mappings[index] = applyProfileMirrorSyncState(current, twitterUsername, syncResult);
      saveConfig(config);
    }
    for (const warning of syncResult.warnings) {
      stepLog(`Profile sync warning: ${warning}`);
    }
  } catch (error) {
    stepLog(
      `Profile sync failed (retry later with sync-profile): ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  console.log(`   ✓ @${twitterUsername} is now mirrored to ${account.handle}`);
  return findMappingByRef(getConfig(), account.handle) ?? null;
}

async function offerBackfill(mappings: AccountMapping[]): Promise<void> {
  if (mappings.length === 0) return;
  const { backfillNow } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'backfillNow',
      message: `Import recent tweets for ${mappings.length} account(s) now? (output streams live)`,
      default: true,
    },
  ]);
  if (!backfillNow) return;

  const { limit } = await inquirer.prompt([
    {
      type: 'input',
      name: 'limit',
      message: 'How many recent tweets per account?',
      default: '15',
    },
  ]);

  for (const mapping of mappings) {
    console.log(`\n=== Backfilling ${mapping.twitterUsernames.join(', ')} -> ${mapping.bskyIdentifier} ===`);
    try {
      await runCoreCommand([
        '--run-once',
        '--backfill-mapping',
        mapping.id,
        '--backfill-limit',
        String(parsePositiveInt(limit, 15)),
        '--no-web',
      ]);
    } catch (error) {
      console.log(`Backfill failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

program
  .command('setup-pds')
  .description('Set up the built-in Bluesky PDS, then walk through tweets-2-bsky configuration')
  .action(async () => {
    console.log('Built-in PDS setup');
    console.log('==================');
    console.log('This runs your own Bluesky PDS inside tweets-2-bsky. Mirrored accounts are');
    console.log('created automatically as [twitterhandle].yourdomain — no manual signup.');
    console.log('\nRequirements for a public PDS:');
    console.log('  - A server with a public IP');
    console.log('  - A domain with A records for both "@" and "*" pointing at it');
    console.log('  - Ports 80/443 reachable (TLS via Caddy or similar; config is generated for you)');
    console.log('  - (Use hostname "localhost" for a local test run without any of the above)\n');

    const config = getConfig();
    const answers = await inquirer.prompt([
      {
        type: 'input',
        name: 'hostname',
        message: 'PDS hostname (e.g. example.com):',
        default: config.pds?.hostname,
        validate: (value: string) => (value.trim().length > 0 ? true : 'Hostname is required'),
      },
      {
        type: 'input',
        name: 'port',
        message: 'Local port for the PDS:',
        default: String(config.pds?.port ?? PDS_DEFAULT_PORT),
      },
    ]);

    const hostname = String(answers.hostname)
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, '');
    const port = parsePositiveInt(answers.port, PDS_DEFAULT_PORT);
    const settings = { enabled: true, hostname, port };

    if (!isLocalPdsHostname(hostname)) {
      const dnsOk = await checkPdsDnsSetup(hostname);
      if (!dnsOk) {
        const { proceed } = await inquirer.prompt([
          {
            type: 'confirm',
            name: 'proceed',
            message: 'DNS is not fully set up. Continue anyway? (handles will not resolve publicly yet)',
            default: false,
          },
        ]);
        if (!proceed) {
          console.log('Setup cancelled. Fix DNS and re-run setup-pds.');
          return;
        }
      }
    }

    console.log('\nGenerating PDS secrets...');
    const { generated } = await generateMissingPdsSecrets();
    if (generated.length > 0) {
      console.log(`   ✓ Generated and saved to .env: ${generated.join(', ')}`);
    } else {
      console.log('   ✓ All PDS secrets already present in .env.');
    }

    const { wantEmail } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'wantEmail',
        message: 'Configure SMTP for outgoing email? (optional — verification is handled automatically without it)',
        default: false,
      },
    ]);
    if (wantEmail) {
      const smtp = await inquirer.prompt([
        { type: 'input', name: 'url', message: 'SMTP URL (e.g. smtps://user:pass@smtp.example.com):' },
        { type: 'input', name: 'from', message: 'From address (e.g. admin@example.com):' },
      ]);
      if (smtp.url?.trim() && smtp.from?.trim()) {
        fs.appendFileSync(
          path.resolve(process.cwd(), '.env'),
          `\nPDS_EMAIL_SMTP_URL=${smtp.url.trim()}\nPDS_EMAIL_FROM_ADDRESS=${smtp.from.trim()}\n`,
        );
        process.env.PDS_EMAIL_SMTP_URL = smtp.url.trim();
        process.env.PDS_EMAIL_FROM_ADDRESS = smtp.from.trim();
        console.log('   ✓ SMTP settings saved to .env.');
      }
    }

    const savedConfig = getConfig();
    savedConfig.pds = settings;
    saveConfig(savedConfig);
    console.log('   ✓ PDS settings saved to config.');

    if (!isLocalPdsHostname(hostname)) {
      const caddyfile = writeCaddyfile(settings);
      console.log(`\nTLS reverse proxy config written to: ${caddyfile}`);
      console.log('Run Caddy with it (installs certificates automatically, including per-handle subdomains):');
      console.log(`   caddy run --config ${caddyfile}`);
      console.log('   (or: docker run -d --network host -v <dir>:/etc/caddy caddy:2)');
    }

    const { tempHandle } = await ensurePdsForCli(settings);

    try {
      // PDS is up — now walk through the tweets-2-bsky side.
      console.log('\ntweets-2-bsky setup');
      console.log('-------------------');
      const freshConfig = getConfig();
      if (!freshConfig.twitter.authToken || !freshConfig.twitter.ct0) {
        console.log('Twitter credentials are needed to read tweets (cookies from a logged-in session).');
        const twitterAnswers = await inquirer.prompt([
          { type: 'input', name: 'authToken', message: 'Twitter auth_token cookie:' },
          { type: 'input', name: 'ct0', message: 'Twitter ct0 cookie:' },
        ]);
        updateTwitterConfig({
          ...freshConfig.twitter,
          authToken: twitterAnswers.authToken.trim(),
          ct0: twitterAnswers.ct0.trim(),
        });
        console.log('   ✓ Twitter credentials saved.');
      } else {
        console.log('   ✓ Twitter credentials already configured.');
      }

      const { interval } = await inquirer.prompt([
        {
          type: 'input',
          name: 'interval',
          message: 'Check for new tweets every N minutes:',
          default: String(getConfig().checkIntervalMinutes),
        },
      ]);
      const intervalConfig = getConfig();
      intervalConfig.checkIntervalMinutes = parsePositiveInt(interval, intervalConfig.checkIntervalMinutes);
      saveConfig(intervalConfig);

      console.log('\nAdd Twitter accounts to mirror. Each gets a PDS account created automatically.');
      const ownerDefault =
        getConfig().users.find((user) => user.role === 'admin')?.username || getConfig().users[0]?.username || '';
      const addedMappings: AccountMapping[] = [];
      for (;;) {
        const { username } = await inquirer.prompt([
          {
            type: 'input',
            name: 'username',
            message: 'Twitter username to mirror (empty to finish):',
          },
        ]);
        const trimmed = normalizeHandle(String(username || ''));
        if (!trimmed) break;
        try {
          const mapping = await mirrorTwitterAccountToPds(settings, trimmed, ownerDefault);
          if (mapping) addedMappings.push(mapping);
        } catch (error) {
          console.log(`   ✗ Failed for @${trimmed}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      await offerBackfill(addedMappings);

      console.log('\nSetup complete.');
      console.log('Start everything (PDS + mirroring + dashboard) with: bun start');
      if (!isLocalPdsHostname(hostname)) {
        console.log(`Mirrored accounts appear on Bluesky as [twitterhandle].${hostname}`);
        console.log('Keep Caddy (or your reverse proxy) running so handles resolve publicly.');
      }
    } finally {
      if (tempHandle) {
        await tempHandle.stop();
      }
    }
  });

program
  .command('add-pds-account [usernames...]')
  .description('Create PDS account(s) for Twitter username(s) and start mirroring them')
  .action(async (usernames: string[] = []) => {
    const config = getConfig();
    if (!config.pds?.hostname) {
      console.log('Built-in PDS is not configured. Run setup-pds first.');
      return;
    }
    const settings = { ...config.pds, enabled: true };

    let targets = usernames.map(normalizeHandle).filter((username) => username.length > 0);
    if (targets.length === 0) {
      const { input } = await inquirer.prompt([
        {
          type: 'input',
          name: 'input',
          message: 'Twitter username(s) to mirror (comma separated):',
        },
      ]);
      targets = String(input || '')
        .split(',')
        .map(normalizeHandle)
        .filter((username) => username.length > 0);
    }
    if (targets.length === 0) {
      console.log('No usernames provided.');
      return;
    }

    const { tempHandle } = await ensurePdsForCli(settings);
    try {
      const ownerDefault =
        config.users.find((user) => user.role === 'admin')?.username || config.users[0]?.username || '';
      const addedMappings: AccountMapping[] = [];
      for (const username of targets) {
        try {
          const mapping = await mirrorTwitterAccountToPds(settings, username, ownerDefault);
          if (mapping) addedMappings.push(mapping);
        } catch (error) {
          console.log(`   ✗ Failed for @${username}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      await offerBackfill(addedMappings);
    } finally {
      if (tempHandle) {
        await tempHandle.stop();
      }
    }
  });

program.parseAsync().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
