import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import cors from 'cors';
import express from 'express';
import jwt from 'jsonwebtoken';
import { getConfig, saveConfig } from './config-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret';

app.use(cors());
app.use(express.json());

// Serve static files from the React app (we will build this later)
app.use(express.static(path.join(__dirname, '../public')));

// Middleware to protect routes
const authenticateToken = (req: any, res: any, next: any) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.split(' ')[1];

  if (!token) return res.sendStatus(401);

  jwt.verify(token, JWT_SECRET, (err: any, user: any) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
};

// --- Auth Routes ---

app.post('/api/register', async (req, res) => {
  const { email, password } = req.body;
  const config = getConfig();

  if (config.users.find((u) => u.email === email)) {
    res.status(400).json({ error: 'User already exists' });
    return;
  }

  const passwordHash = await bcrypt.hash(password, 10);
  config.users.push({ email, passwordHash });
  saveConfig(config);

  res.json({ success: true });
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  const config = getConfig();
  const user = config.users.find((u) => u.email === email);

  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  const token = jwt.sign({ email: user.email }, JWT_SECRET, { expiresIn: '24h' });
  res.json({ token });
});

// --- Mapping Routes ---

app.get('/api/mappings', authenticateToken, (_req, res) => {
  const config = getConfig();
  res.json(config.mappings);
});

app.post('/api/mappings', authenticateToken, (req, res) => {
  const { twitterUsername, bskyIdentifier, bskyPassword, bskyServiceUrl, owner } = req.body;
  const config = getConfig();

  const newMapping = {
    id: Math.random().toString(36).substring(7),
    twitterUsername,
    bskyIdentifier,
    bskyPassword,
    bskyServiceUrl: bskyServiceUrl || 'https://bsky.social',
    enabled: true,
    owner,
  };

  config.mappings.push(newMapping);
  saveConfig(config);
  res.json(newMapping);
});

app.delete('/api/mappings/:id', authenticateToken, (req, res) => {
  const { id } = req.params;
  const config = getConfig();
  config.mappings = config.mappings.filter((m) => m.id !== id);
  saveConfig(config);
  res.json({ success: true });
});

// --- Twitter Config Routes ---

app.get('/api/twitter-config', authenticateToken, (_req, res) => {
  const config = getConfig();
  res.json(config.twitter);
});

app.post('/api/twitter-config', authenticateToken, (req, res) => {
  const { authToken, ct0 } = req.body;
  const config = getConfig();
  config.twitter = { authToken, ct0 };
  saveConfig(config);
  res.json({ success: true });
});

// Serve the frontend for any other route
app.get('/*', (_req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

export function startServer() {
  app.listen(PORT, '0.0.0.0' as any, () => {
    console.log(`🚀 Web interface running at http://localhost:${PORT}`);
    console.log('📡 Accessible on your local network/Tailscale via your IP.');
  });
}
