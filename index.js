/**
 * index.js — Persona Dashboard + Orchestrator with OpenAI integration
 * Requirements: Node 16+, install dependencies from package.json provided earlier
 *
 * .env:
 * PORT=3000
 * ADMIN_KEY=your_secret_key
 * RATE_WINDOW_MS=15000
 * RATE_MAX=20
 * OPENAI_KEY=sk-...
 */

import 'dotenv/config';
import express from 'express';
import path from 'path';
import fs from 'fs-extra';
import rateLimit from 'express-rate-limit';
import cors from 'cors';
import helmet from 'helmet';
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const PERSONAS_FILE = path.join(__dirname, 'data', 'personas.json');

fs.ensureDirSync(path.join(__dirname, 'data'));
if (!fs.existsSync(PERSONAS_FILE)) fs.writeFileSync(PERSONAS_FILE, JSON.stringify([], null, 2), 'utf8');

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '300kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// rate limiter
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_WINDOW_MS || '15000', 10),
  max: parseInt(process.env.RATE_MAX || '20', 10),
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api/', limiter);

function requireAdminKey(req, res, next) {
  if (!ADMIN_KEY) return next();
  const key = req.headers['x-admin-key'] || req.body?.adminKey || req.query?.adminKey;
  if (key === ADMIN_KEY) return next();
  return res.status(401).json({ error: 'Missing or invalid admin key' });
}

function readPersonas() {
  try {
    const raw = fs.readFileSync(PERSONAS_FILE, 'utf8');
    return JSON.parse(raw || '[]');
  } catch (e) {
    return [];
  }
}
function writePersonas(list) {
  fs.writeFileSync(PERSONAS_FILE, JSON.stringify(list, null, 2), 'utf8');
}

function genId() {
  return Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');
}

// ----------------- Person API -----------------
/*
Persona schema:
{
  id: "abc123",
  name: "Alpha",
  avatarUrl: "https://i.imgur.com/abc.png",
  defaultWebhook: "https://discord.com/api/webhooks/..."
}
*/

app.get('/api/personas', (req, res) => {
  return res.json({ personas: readPersonas() });
});

app.post('/api/personas', requireAdminKey, (req, res) => {
  const { name, avatarUrl, defaultWebhook } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  const list = readPersonas();
  const id = genId();
  const p = { id, name: String(name).slice(0, 80), avatarUrl: avatarUrl ? String(avatarUrl).slice(0, 500) : '', defaultWebhook: defaultWebhook ? String(defaultWebhook).slice(0,800) : '' };
  list.push(p);
  writePersonas(list);
  return res.status(201).json({ persona: p });
});

app.put('/api/personas/:id', requireAdminKey, (req, res) => {
  const id = req.params.id;
  const { name, avatarUrl, defaultWebhook } = req.body || {};
  const list = readPersonas();
  const idx = list.findIndex(x => x.id === id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  if (name) list[idx].name = String(name).slice(0,80);
  if (avatarUrl !== undefined) list[idx].avatarUrl = avatarUrl ? String(avatarUrl).slice(0,500) : '';
  if (defaultWebhook !== undefined) list[idx].defaultWebhook = defaultWebhook ? String(defaultWebhook).slice(0,800) : '';
  writePersonas(list);
  return res.json({ persona: list[idx] });
});

app.delete('/api/personas/:id', requireAdminKey, (req, res) => {
  const id = req.params.id;
  const list = readPersonas();
  const newList = list.filter(x => x.id !== id);
  writePersonas(newList);
  return res.json({ ok: true });
});

// ----------------- Send via webhook (single send) -----------------
app.post('/api/send', requireAdminKey, async (req, res) => {
  try {
    const { webhookUrl, personaId, content, tts, username, avatarUrl } = req.body || {};
    if (!webhookUrl || !content) return res.status(400).json({ error: 'webhookUrl and content required' });

    let usernameToUse = username || 'Persona';
    let avatarToUse = avatarUrl || undefined;
    if (personaId) {
      const p = readPersonas().find(x => x.id === personaId);
      if (p) { usernameToUse = p.name; avatarToUse = p.avatarUrl || avatarToUse; if (!webhookUrl && p.defaultWebhook) webhookUrl = p.defaultWebhook; }
    }

    const payload = { content: String(content).slice(0,2000) };
    if (usernameToUse) payload.username = String(usernameToUse).slice(0,80);
    if (avatarToUse) payload.avatar_url = String(avatarToUse).slice(0,500);
    if (tts) payload.tts = !!tts;

    const r = await fetch(webhookUrl, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload), timeout: 10000 });
    if (!r.ok) {
      const text = await r.text();
      return res.status(400).json({ ok: false, status: r.status, details: text });
    }

    return res.json({ ok: true, sentAs: payload.username || null });
  } catch (err) {
    console.error('send error', err);
    return res.status(500).json({ error: err.message || 'internal' });
  }
});

// ----------------- Conversation Orchestrator -----------------
const conversations = new Map();

function fallbackMessage(personaName, lastMessage) {
  const samples = [
    `Interesting — ${personaName} thinks that's cool.`,
    `I agree. Quick thought: ${Math.random().toString(36).slice(2,8)}`,
    `Could you expand a bit more?`,
    `That's neat. I like that idea.`,
    `Short reply: yes, makes sense.`
  ];
  return samples[Math.floor(Math.random() * samples.length)];
}

async function generateAIMessage(openaiKey, personaName, convoHistory) {
  if (!openaiKey) return null;
  try {
    // Build messages for Chat API
    const system = { role: 'system', content: `You are ${personaName}. Keep replies short (1-2 sentences). Stay in character.` };
    const messages = [system].concat(convoHistory.slice(-8).map(h => ({ role: 'user', content: `${h.role}: ${h.content}` })));
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${openaiKey}`, 'Content-Type':'application/json' },
      body: JSON.stringify({ model: 'gpt-3.5-turbo', messages, max_tokens: 120, temperature: 0.8 })
    });
    if (!resp.ok) {
      const txt = await resp.text();
      console.error('OpenAI error', resp.status, txt);
      return null;
    }
    const j = await resp.json();
    const aiText = j?.choices?.[0]?.message?.content;
    return (typeof aiText === 'string') ? aiText.trim() : null;
  } catch (err) {
    console.error('OpenAI call failed', err);
    return null;
  }
}

app.post('/api/start-convo', requireAdminKey, async (req, res) => {
  try {
    const { participants, intervalMs = 8000, useAI = false, starter = '' } = req.body || {};
    if (!Array.isArray(participants) || participants.length < 2) return res.status(400).json({ error: 'participants array required (min 2)' });

    // validate participants
    for (const p of participants) {
      if (!p.name || (!p.webhookUrl && !p.personaId)) {
        return res.status(400).json({ error: 'Each participant needs a name and either webhookUrl or personaId (with saved webhook)' });
      }
      // if personaId provided and no webhookUrl, resolve defaultWebhook
      if (!p.webhookUrl && p.personaId) {
        const per = readPersonas().find(x => x.id === p.personaId);
        if (!per || !per.defaultWebhook) return res.status(400).json({ error: `personaId ${p.personaId} has no saved default webhook` });
        p.webhookUrl = per.defaultWebhook;
        if (!p.avatarUrl) p.avatarUrl = per.avatarUrl;
        if (!p.name) p.name = per.name;
      }
    }

    const id = genId();
    const convoState = {
      id,
      participants,
      intervalMs: Math.max(3000, Number(intervalMs) || 8000),
      useAI: !!useAI && !!process.env.OPENAI_KEY,
      history: [],
      running: true,
      index: 0
    };
    conversations.set(id, convoState);

    // kick off loop
    (async function loop() {
      if (starter) {
        const p = convoState.participants[0];
        const payload = { username: p.name, content: String(starter).slice(0,2000) };
        if (p.avatarUrl) payload.avatar_url = p.avatarUrl;
        try {
          await fetch(p.webhookUrl, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload) });
          convoState.history.push({ role: p.name, content: payload.content });
        } catch (e) { console.error('starter send error', e); }
        await new Promise(r => setTimeout(r, convoState.intervalMs));
        convoState.index = 1 % convoState.participants.length;
      }

      while (conversations.has(id) && conversations.get(id).running) {
        const state = conversations.get(id);
        const participant = state.participants[state.index];
        let content = null;
        if (state.useAI) {
          const convoMessages = state.history.map(h => ({ role: 'user', content: `${h.role}: ${h.content}` }));
          content = await generateAIMessage(process.env.OPENAI_KEY, participant.name, convoMessages) || fallbackMessage(participant.name, state.history.slice(-1)[0]?.content);
        } else {
          content = fallbackMessage(participant.name, state.history.slice(-1)[0]?.content);
        }

        const payload = { username: participant.name, content: String(content).slice(0,2000) };
        if (participant.avatarUrl) payload.avatar_url = participant.avatarUrl;

        try {
          const r = await fetch(participant.webhookUrl, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload) });
          if (!r.ok) {
            const t = await r.text();
            console.error('webhook post failed', r.status, t);
          } else {
            state.history.push({ role: participant.name, content });
            if (state.history.length > 80) state.history.shift();
          }
        } catch (err) {
          console.error('send error', err);
        }

        state.index = (state.index + 1) % state.participants.length;
        await new Promise(r => setTimeout(r, state.intervalMs));
      }
    })();

    return res.json({ id, ok: true });
  } catch (err) {
    console.error('start-convo error', err);
    return res.status(500).json({ error: 'internal' });
  }
});

app.post('/api/stop-convo', requireAdminKey, (req, res) => {
  const { id } = req.body || {};
  if (!id || !conversations.has(id)) return res.status(400).json({ error: 'invalid id' });
  const state = conversations.get(id);
  state.running = false;
  conversations.delete(id);
  return res.json({ ok: true });
});

app.get('/api/list-convos', requireAdminKey, (req, res) => {
  const list = Array.from(conversations.values()).map(c => ({ id: c.id, participants: c.participants.map(p => p.name), intervalMs: c.intervalMs, useAI: c.useAI, running: c.running }));
  return res.json({ active: list });
});

// Health & default
app.get('/health', (req, res) => res.json({ ok: true }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`Persona dashboard + orchestrator running on http://localhost:${PORT}`);
});
