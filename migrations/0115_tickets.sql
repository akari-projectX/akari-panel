-- W17: support tickets (工单, xboard parity). Text only (no attachments),
-- length caps enforced here as well as in the API. A ticket belongs to one
-- customer account (deleted with it); messages keep the author's login as
-- a snapshot (staff accounts may be deleted later).
--
-- Status: open = waiting for staff, answered = staff replied last,
-- closed (by the user or staff; closed_at/closed_by set). Unread markers:
-- the user has unread staff replies while last_staff_at > user_read_at,
-- staff have unread user messages while last_user_at > staff_read_at.

CREATE TABLE tickets (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    subject TEXT NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 120),
    category TEXT NOT NULL
        CHECK (category IN ('general', 'billing', 'technical', 'account', 'other')),
    priority TEXT NOT NULL CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'answered', 'closed')),
    -- Optional context the user picked (their own order / a node they use).
    order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
    node_id UUID REFERENCES nodes(id) ON DELETE SET NULL,
    assignee_id UUID REFERENCES users(id) ON DELETE SET NULL,
    messages INT NOT NULL DEFAULT 0 CHECK (messages BETWEEN 0 AND 200),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_user_at TIMESTAMPTZ,
    last_staff_at TIMESTAMPTZ,
    user_read_at TIMESTAMPTZ,
    staff_read_at TIMESTAMPTZ,
    closed_at TIMESTAMPTZ,
    closed_by TEXT CHECK (closed_by IN ('user', 'staff')),
    CHECK ((status = 'closed') = (closed_at IS NOT NULL)),
    CHECK ((closed_at IS NULL) = (closed_by IS NULL))
);

CREATE INDEX tickets_user ON tickets (user_id, updated_at DESC, id);
CREATE INDEX tickets_queue ON tickets (updated_at DESC, id);
CREATE INDEX tickets_open ON tickets (status) WHERE status <> 'closed';
CREATE INDEX tickets_assignee ON tickets (assignee_id) WHERE assignee_id IS NOT NULL;

CREATE TABLE ticket_messages (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ticket_id UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    author_id UUID REFERENCES users(id) ON DELETE SET NULL,
    author_login TEXT NOT NULL,
    staff BOOLEAN NOT NULL,
    body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 5000),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ticket_messages_ticket ON ticket_messages (ticket_id, id);
