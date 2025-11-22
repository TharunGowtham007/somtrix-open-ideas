const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');

const app = express();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// Ensure data directory exists
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir);
}

// SQLite DB
const dbPath = path.join(dataDir, 'ideas.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Failed to connect to SQLite DB', err);
  } else {
    console.log('Connected to SQLite DB at', dbPath);
  }
});

// Create ideas table
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS ideas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      author TEXT,
      title TEXT NOT NULL,
      problem TEXT NOT NULL,
      solution_hint TEXT NOT NULL,
      votes INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `, (err) => {
    if (err) {
      console.error('Failed to create ideas table', err);
    } else {
      console.log('Ideas table is ready');
    }
  });
});

// Helpers for sort/search
function buildIdeasQuery(params) {
  const { sort, search } = params;
  let sql = 'SELECT * FROM ideas';
  const sqlParams = [];

  if (search) {
    sql += ' WHERE LOWER(title) LIKE ? OR LOWER(author) LIKE ?';
    const like = `%${search.toLowerCase()}%`;
    sqlParams.push(like, like);
  }

  if (sort === 'new') {
    sql += ' ORDER BY datetime(created_at) DESC, votes DESC';
  } else {
    sql += ' ORDER BY votes DESC, datetime(created_at) DESC';
  }

  return { sql, sqlParams };
}

// API routes

// Get ideas
app.get('/api/ideas', (req, res) => {
  const { sql, sqlParams } = buildIdeasQuery(req.query);
  db.all(sql, sqlParams, (err, rows) => {
    if (err) {
      console.error('Error fetching ideas', err);
      return res.status(500).json({ error: 'Failed to fetch ideas' });
    }
    res.json(rows);
  });
});

// Create idea
app.post('/api/ideas', (req, res) => {
  const { author = '', title, problem, solution_hint } = req.body;

  if (!title || !problem || !solution_hint) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const stmt = db.prepare(`
    INSERT INTO ideas (author, title, problem, solution_hint)
    VALUES (?, ?, ?, ?)
  `);

  stmt.run(author.trim(), title.trim(), problem.trim(), solution_hint.trim(), function (err) {
    if (err) {
      console.error('Error inserting idea', err);
      return res.status(500).json({ error: 'Failed to save idea' });
    }

    const id = this.lastID;
    db.get('SELECT * FROM ideas WHERE id = ?', [id], (err2, row) => {
      if (err2) {
        console.error('Error fetching new idea', err2);
        return res.status(500).json({ error: 'Idea created but failed to reload' });
      }
      res.status(201).json(row);
    });
  });

  stmt.finalize();
});

// Vote for an idea
app.post('/api/ideas/:id/vote', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) {
    return res.status(400).json({ error: 'Invalid idea id' });
  }

  db.run(
    'UPDATE ideas SET votes = votes + 1 WHERE id = ?',
    [id],
    function (err) {
      if (err) {
        console.error('Error updating votes', err);
        return res.status(500).json({ error: 'Failed to support idea' });
      }
      if (this.changes === 0) {
        return res.status(404).json({ error: 'Idea not found' });
      }
      db.get('SELECT * FROM ideas WHERE id = ?', [id], (err2, row) => {
        if (err2) {
          console.error('Error fetching updated idea', err2);
          return res.status(500).json({ error: 'Idea updated but failed to reload' });
        }
        res.json(row);
      });
    }
  );
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Serve landing page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Use PORT environment variable for Render
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`SomTriX ideas board listening on port ${PORT}`);
});
