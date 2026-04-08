# AgentMail

Email integration for Wolverine Claw. Allows the agent to send, receive, and manage emails through the AgentMail API.

## Configuration

Set `AGENTMAIL_API_KEY` in `.env.local`.

Inbox: `wolverineai@agentmail.to`

## API Reference

Base URL: `https://api.agentmail.to/v0`
Auth: `Authorization: Bearer $AGENTMAIL_API_KEY`

### List Inboxes
```
GET /v0/inboxes
```

### List Messages
```
GET /v0/inboxes/{inbox_id}/messages
```

### Read Message
```
GET /v0/inboxes/{inbox_id}/messages/{message_id}
```

### Send Email
```
POST /v0/inboxes/{inbox_id}/messages/send
Body: { "to": ["recipient@example.com"], "subject": "Subject", "text": "Body" }
```

### Reply to Message
```
POST /v0/inboxes/{inbox_id}/messages/{message_id}/reply
Body: { "text": "Reply body" }
```

### List Threads
```
GET /v0/inboxes/{inbox_id}/threads
```
