# Contract 3: conversations and branches

**Version:** 0.1-draft · **Status:** partly implemented (linear chats)

## A conversation

```json
{ "type": "chat", "id": "…", "title": "…", "created": "…",
  "origin": "window" | "atelier" | "discord:<guild>/<channel>" | "vector:<chat>" | "schedule:<id>",
  "consent": "<consent record id>" }
```

- **`origin`** says where the conversation lives outside the island. It replaces the Atelier's per-browser map of bridge
  chats to branches (`agentChats`), so every body finds the same conversation for the same Discord channel or Vector
  chat.
- **`consent`** is created **with** the conversation, before anything is processed or derived from it (contract 5):
  who is in it, what they've agreed to, and the scope its work runs under.

## Messages form a tree

```json
{ "type": "message", "id": "m-…", "parent": "m-…", "n": 12, "role": "user" | "assistant" | "tool" | "system",
  "content": "…", "at": "…", "by": "…",
  "tool_calls": [ … ], "reasoning_content": "…", "tool_call_id": "…", "name": "…", "model": "…",
  "compaction": { "covers": ["m-…", "…"] }, "epoch": 7, "divergent": false }
```

- **Branches:** siblings share a `parent`. A conversation's **head** is the branch a client continues by default.
- **Messages are kept whole,** as models need them back: tool calls with their ids, reasoning, and tool results that
  answer them.
- **Storage** (built): one append-only JSONL file per conversation. Today's files are the single-branch case: no `id`
  or `parent`, and the order is the branch. Readers treat a missing `parent` as "the previous message", so nothing
  existing breaks.
- **Compaction** is a message, not a rewrite: it names what it covers, and the covered messages stay in the file.
- **Divergent work** from a runtime without the lease (contract 1) is kept as its own branch, marked `divergent`.

## Search

Search covers titles, words, compaction summaries and tool calls, **within the reader's scope** (contract 5). Indexes
are derived and rebuildable (contract 8).

## Acceptance tests

| id | Test | Status |
|---|---|---|
| C-01 | Chats are files; the log keeps facts, not words; a torn last line doesn't lose the chat | **passing** (`core/test/log.test.ts`) |
| C-02 | Messages are kept whole (tool calls, reasoning, tool results tied to their calls) and go back to the model that way | **passing** (`core/test/agent.test.ts`) |
| C-03 | Moved-in Atelier sessions become chats, with times and tool pairing kept | **passing** (`core/test/import.test.ts`) |
| C-04 | A branch made from any message continues independently; the original branch is unchanged | pending |
| C-05 | Old linear files read as one branch, and appending a branch to them doesn't rewrite them | pending |
| C-06 | A conversation from a bridge is found by its `origin` from any client, so no second conversation is made for the same channel | pending |
| C-07 | A conversation has a consent record from its first message; processing (journal, embeddings, memory) refers to it | pending |
| C-08 | Compaction adds a message that covers earlier ones; nothing is deleted | pending |
| C-09 | Search across branches returns matches only from conversations the reader's scope covers | pending |
