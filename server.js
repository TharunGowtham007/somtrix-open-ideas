const express = require("express");
const cors = require("cors");
const path = require("path");
const sqlite3 = require("sqlite3").verbose();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(cors());

// Serve static frontend
app.use(express.static(path.join(__dirname, "public")));

// --- SQLite DB setup ---
const db = new sqlite3.Database(path.join(__dirname, "ideas.db"), (err) => {
  if (err) {
    console.error("Failed to open DB", err);
  } else {
    console.log("Connected to SQLite DB");
  }
});

db.serialize(() => {
  db.run(
    `CREATE TABLE IF NOT EXISTS ideas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      author TEXT,
      title TEXT NOT NULL,
      problem TEXT NOT NULL,
      solution_hint TEXT NOT NULL,
      votes INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    )`,
    (err) => {
      if (err) console.error("Error creating table:", err);
    }
  );
});

// --- Helpers ---
function sanitizeString(str) {
  if (typeof str !== "string") return "";
  return str.trim();
}

// --- API routes ---

// GET /api/ideas – list all ideas
app.get("/api/ideas", (req, res) => {
  const sort = req.query.sort === "new" ? "new" : "top";
  const search = sanitizeString(req.query.search || "");

  let baseQuery = "SELECT * FROM ideas";
  const params = [];

  if (search) {
    baseQuery += " WHERE LOWER(title) LIKE ? OR LOWER(author) LIKE ?";
    const like = `%${search.toLowerCase()}%`;
    params.push(like, like);
  }

  if (sort === "new") {
    baseQuery += " ORDER BY created_at DESC";
  } else {
    baseQuery += " ORDER BY votes DESC, created_at DESC";
  }

  db.all(baseQuery, params, (err, rows) => {
    if (err) {
      console.error("Error fetching ideas:", err);
      return res.status(500).json({ error: "Failed to fetch ideas" });
    }
    res.json(rows);
  });
});

// POST /api/ideas – create new idea
app.post("/api/ideas", (req, res) => {
  const author = sanitizeString(req.body.author || "");
  const title = sanitizeString(req.body.title || "");
  const problem = sanitizeString(req.body.problem || "");
  const solution_hint = sanitizeString(req.body.solution_hint || "");

  if (!title || !problem || !solution_hint) {
    return res
      .status(400)
      .json({ error: "title, problem, and solution_hint are required" });
  }

  // Simple length limits
  if (title.length > 160 || problem.length > 1000 || solution_hint.length > 600) {
    return res.status(400).json({ error: "Input too long" });
  }

  const created_at = Date.now();
  const sql =
    "INSERT INTO ideas (author, title, problem, solution_hint, votes, created_at) VALUES (?, ?, ?, ?, 0, ?)";
  const params = [author, title, problem, solution_hint, created_at];

  db.run(sql, params, function (err) {
    if (err) {
      console.error("Error inserting idea:", err);
      return res.status(500).json({ error: "Failed to save idea" });
    }
    res.status(201).json({
      id: this.lastID,
      author,
      title,
      problem,
      solution_hint,
      votes: 0,
      created_at,
    });
  });
});

// POST /api/ideas/:id/vote – increment votes
app.post("/api/ideas/:id/vote", (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) {
    return res.status(400).json({ error: "Invalid idea ID" });
  }

  db.run(
    "UPDATE ideas SET votes = votes + 1 WHERE id = ?",
    [id],
    function (err) {
      if (err) {
        console.error("Error updating vote:", err);
        return res.status(500).json({ error: "Failed to vote" });
      }
      if (this.changes === 0) {
        return res.status(404).json({ error: "Idea not found" });
      }

      db.get("SELECT * FROM ideas WHERE id = ?", [id], (err2, row) => {
        if (err2) {
          console.error("Error fetching idea after vote:", err2);
          return res.status(500).json({ error: "Failed to fetch idea" });
        }
        res.json(row);
      });
    }
  );
});

// Fallback: SPA support
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Start server
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
