import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { query } from '../db.js';
import { signToken, authRequired } from '../middleware/auth.js';

const router = Router();
const SALT = 12;

router.post('/register', async (req, res) => {
  try {
    const { email, password, full_name } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }
    const exists = await query('SELECT id FROM users WHERE email = $1', [
      email.trim().toLowerCase(),
    ]);
    if (exists.rows.length) {
      return res.status(409).json({ error: 'Email already registered' });
    }
    const password_hash = await bcrypt.hash(String(password), SALT);
    const ins = await query(
      `INSERT INTO users (email, password_hash, full_name)
       VALUES ($1, $2, $3)
       RETURNING id, email, full_name, created_at`,
      [email.trim().toLowerCase(), password_hash, full_name || null]
    );
    const user = ins.rows[0];
    const token = signToken({ sub: user.id, email: user.email });
    return res.status(201).json({ user, token });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Registration failed' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }
    const r = await query('SELECT * FROM users WHERE email = $1', [
      email.trim().toLowerCase(),
    ]);
    if (!r.rows.length) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const user = r.rows[0];
    const ok = await bcrypt.compare(String(password), user.password_hash);
    if (!ok) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const token = signToken({ sub: user.id, email: user.email });
    delete user.password_hash;
    return res.json({ user, token });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Login failed' });
  }
});

router.get('/me', authRequired, async (req, res) => {
  try {
    const r = await query(
      'SELECT id, email, full_name, created_at FROM users WHERE id = $1',
      [req.user.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'User not found' });
    return res.json({ user: r.rows[0] });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to load user' });
  }
});

export default router;
