CREATE TABLE IF NOT EXISTS inboxes (
  id uuid PRIMARY KEY,
  address text NOT NULL UNIQUE,
  token_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS inboxes_expiry ON inboxes (expires_at);

-- Raw MIME is the durable queue payload in this initial service.
CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY,
  envelope_from text NOT NULL,
  raw bytea NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'ready', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  retry_at timestamptz NOT NULL DEFAULT now(),
  subject text,
  sender text,
  text_body text,
  attachments jsonb NOT NULL DEFAULT '[]'::jsonb
);
CREATE INDEX IF NOT EXISTS messages_queue ON messages (retry_at, received_at) WHERE state = 'pending';

CREATE TABLE IF NOT EXISTS deliveries (
  inbox_id uuid NOT NULL REFERENCES inboxes(id) ON DELETE CASCADE,
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  PRIMARY KEY (inbox_id, message_id)
);
CREATE INDEX IF NOT EXISTS deliveries_message ON deliveries (message_id);
