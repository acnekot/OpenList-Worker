CREATE TABLE IF NOT EXISTS user_quota_reservations (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_user_quota_reservations_user
  ON user_quota_reservations (username, expires_at, completed_at);
