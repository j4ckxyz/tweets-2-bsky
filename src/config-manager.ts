import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONFIG_FILE = path.join(__dirname, '..', 'config.json');

export interface TwitterConfig {
  authToken: string;
  ct0: string;
}

export interface AccountMapping {
  id: string;
  twitterUsername: string;
  bskyIdentifier: string;
  bskyPassword: string;
  bskyServiceUrl?: string;
  enabled: boolean;
}

export interface AppConfig {
  twitter: TwitterConfig;
  mappings: AccountMapping[];
  checkIntervalMinutes: number;
}

export function getConfig(): AppConfig {
  if (!fs.existsSync(CONFIG_FILE)) {
    return {
      twitter: { authToken: '', ct0: '' },
      mappings: [],
      checkIntervalMinutes: 5,
    };
  }
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (err) {
    console.error('Error reading config:', err);
    return {
      twitter: { authToken: '', ct0: '' },
      mappings: [],
      checkIntervalMinutes: 5,
    };
  }
}

export function saveConfig(config: AppConfig): void {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

export function addMapping(mapping: Omit<AccountMapping, 'id' | 'enabled'>): void {
  const config = getConfig();
  const newMapping: AccountMapping = {
    ...mapping,
    id: Math.random().toString(36).substring(7),
    enabled: true,
  };
  config.mappings.push(newMapping);
  saveConfig(config);
}

export function removeMapping(id: string): void {
  const config = getConfig();
  config.mappings = config.mappings.filter((m) => m.id !== id);
  saveConfig(config);
}

export function updateTwitterConfig(twitter: TwitterConfig): void {
  const config = getConfig();
  config.twitter = twitter;
  saveConfig(config);
}
