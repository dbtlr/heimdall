---
description: "How a person or an agent queries Session insight through the insight reader, a read-only PostgreSQL role that reads the insight views and nothing else: what the provisioner sets up, how serve grants the role, what it can and cannot read, example queries, and how a locator leads to raw transcript lines."
---

# Querying the insight views

The `insight` views in the Hub's database are the one read model for Session insight ([ADR-0014](decisions/0014-session-insight-is-a-rebuildable-projection-read-through-insight-views.md)). The [spec](spec.md#the-insight-views) lists every view and column. This document describes how to query them through the insight reader: a read-only role that reads the views and nothing else.

## Set up the reader

The provisioner does two things. Heimdall never creates the role and never handles its password.

1. It creates a login role with a password in the Hub's PostgreSQL server, such as `heimdall_insight`, and lets it connect to the Hub's database. The role is not a superuser and is not a member of the Hub's own role or of `pg_read_all_data`; `serve` refuses to grant any of these, or the Hub's own role, since each reads every table already.
2. It names the role in the Hub's configuration file, `~/.config/heimdall/hub.toml`:

```toml
[database]
url = "postgres://heimdall@db.example:5432/heimdall"
insight_reader = "heimdall_insight"
```

`serve` also reads the name from `--insight-reader` or `HEIMDALL_INSIGHT_READER`. The name is lowercase letters, digits, and underscores, at most 63 characters, and is not `public`, `none`, or a `pg_` role.

The insight reader needs PostgreSQL 15 or later, where no role but the database's owner can create objects in the `public` schema by default.

## What serve grants

Each time `serve` starts, after it applies the migrations, it grants the role:

- `USAGE` on the `insight` schema.
- `SELECT` on every view in the schema.
- Default privileges that give the role `SELECT` on every view the Hub's role creates in the schema later.

The views run with their owner's rights, so the role needs no access to the tables beneath them, and it has none. It cannot read transcripts, tokens, Pairing codes, Vitals, or any other table, and it cannot write to any table or view. Each view is a security barrier, so a filter the role writes runs only on rows the view shows, and no error or function in it can surface a row the view hides. Granting again changes nothing.

The grant covers views that later migrations add or replace. A migration that drops a view and creates it again drops its grants, and the default privileges give the role the new view at once. A view created before the role existed is granted when `serve` next tries.

A migration that creates or replaces an `insight` view:

- Says `WITH (security_barrier = true)`. CREATE OR REPLACE VIEW resets the option, and a test fails for any `insight` view without it.
- Calls only functions that read no table. The reader has no access to the tables, so a security-invoker function that reads one denies it.

| Situation | What `serve` does |
| --- | --- |
| The role exists | Grants it and logs `Granted <role> read access to the insight views.` |
| The role does not exist yet | Logs a warning once, grants nothing, and starts. It tries again every minute and grants the role once the provisioner creates it. |
| The role is the Hub's own, a superuser, a member of the Hub's role, or a member of `pg_read_all_data` | Logs a warning that says why, grants nothing, and does not try again. |
| No role is configured | Grants nothing and logs nothing. |
| The grant fails, such as on a lock a backup holds | Logs a warning, starts, and tries again every minute. |

Removing the setting does not revoke a grant, and a grant stays with the role while it exists. To remove the reader, drop it in the Hub's database with `DROP OWNED BY heimdall_insight; DROP ROLE heimdall_insight;`.

## What the reader can still do

PostgreSQL lets every role do some things in a database it can connect to. The Hub takes away what its own role can:

- **Temporary tables.** When the Hub's role owns its database, `serve` revokes the right to create temporary tables from every role but the owner. The Hub creates none. When it does not own the database, `serve` logs a warning and the reader can still create them; the provisioner revokes it.

Only a superuser can take away the rest, so it remains unless the provisioner does:

- **Large objects.** Any role can call `lo_create`, `lo_creat`, and `lo_from_bytea`, which store data in the database that persists after the session. The provisioner revokes EXECUTE on them from PUBLIC in the Hub's database.
- **Advisory locks.** Any role can take an advisory lock, including the one the Hub's migrations take, which holds a starting Hub back while it is held.
- **Heavy queries.** A query runs as long as the server lets it. The provisioner can set a `statement_timeout` for the role.

[ADR-0009](decisions/0009-collectors-pair-with-the-hub.md) treats access to the Hub's database as trusted. The insight reader is trusted the same way not to abuse these rights. It is never given what the views leave out.

## What the views hold

The views carry facts and locators, never transcript content: no prompt, response, thinking, tool input, or tool output. A name or an id is shaped as one, so prose cannot reach those columns. A few columns are text as the Harness or the Collector wrote it:

- `first_cwd` and `last_cwd`, the working directories, and `first_git_branch` and `last_git_branch`, in `insight.sessions`.
- `path`, the path of a transcript file within its source, in the Session, subagent, request, and tool call views.

## Example queries

Sessions started each day for the last 30 days, with their tokens, subagents included:

```sql
SELECT date_trunc('day', s.started_at) AS day, count(*) AS sessions,
       sum(t.input_tokens + t.output_tokens) AS tokens
FROM insight.sessions s
JOIN insight.session_totals t USING (harness, system, source, session_id)
WHERE s.started_at > now() - interval '30 days'
GROUP BY day
ORDER BY day;
```

Output tokens per hour and model for the last week, as a graph reads them:

```sql
SELECT date_trunc('hour', at) AS hour, model, sum(output_tokens) AS output_tokens
FROM insight.requests
WHERE at > now() - interval '7 days'
GROUP BY hour, model
ORDER BY hour, model;
```

The tools one Session called, most called first:

```sql
SELECT name, mcp_server, count(*) AS calls
FROM insight.tool_calls
WHERE system = 'laptop-1' AND session_id = '0b1c2d3e-0000-4000-8000-000000000001'
GROUP BY name, mcp_server
ORDER BY calls DESC;
```

A Session's subagents, with the subagent that spawned each:

```sql
SELECT agent_id, parent_agent_id, agent_type, depth, started_at, ended_at
FROM insight.subagents
WHERE system = 'laptop-1' AND session_id = '0b1c2d3e-0000-4000-8000-000000000001'
ORDER BY started_at;
```

## From a locator to the raw lines

A request or a tool call carries a locator: `system`, `source`, `path`, `generation`, and `byte_offset`. The reader finds it in the views:

```sql
SELECT system, source, path, generation, byte_offset
FROM insight.requests
WHERE request_id = 'msg_01AbCdEf';
```

The raw lines are not in the views. On the Hub's System, the operator prints every line of the request with the Hub's own access:

```sh
heimdall-hub transcripts show --system laptop-1 --source claude-code --request msg_01AbCdEf
```

A Claude Code request spans one line per content block. The locator names only the line its usage was read from, which `--generation` and `--offset` print alone:

```sh
heimdall-hub transcripts show --system laptop-1 --source claude-code \
  --path 'projects/-home-someone-work-my-project/0b1c2d3e-0000-4000-8000-000000000001.jsonl' \
  --generation 42 --offset 1234
```

`heimdall-hub transcripts show --system laptop-1 --source claude-code --session <id>` prints the Session's main conversation, and `--agent <id>` one of its subagents. The [spec](spec.md#upload-protocol) describes every option.
