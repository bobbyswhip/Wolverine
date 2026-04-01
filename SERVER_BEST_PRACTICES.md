# Wolverine Server Best Practices

Rules for building secure, scalable, well-structured servers. Wolverine's agent follows these when building or editing server code.

## Structure

```
server/
├── index.js          Entry point — app setup, middleware, route mounting, listen
├── routes/           Route modules — one file per resource
│   ├── health.js     Health check endpoint (always required)
│   └── api.js        API routes
├── middleware/        Custom middleware (auth, validation, logging)
├── models/           Data models / database schemas
├── services/         Business logic (keep routes thin)
├── config/           Configuration files
└── utils/            Shared utilities
```

## Rules

### Security
- Never expose secrets in responses — use env vars, never hardcode
- Validate ALL input — use express.json() with size limits
- Use helmet() for HTTP security headers in production
- Rate limit public endpoints
- Sanitize user input before database queries
- Never return stack traces in production error responses

### Scalability
- Keep routes thin — business logic goes in services/
- Use async/await, never block the event loop
- Add a /health endpoint that returns status + uptime + memory
- Use environment variables for all configuration
- Structure for horizontal scaling — no in-memory session state

### Error Handling
- Always have a global error handler middleware
- Log errors with context (timestamp, request path, user)
- Return consistent error response format: { error: "message" }
- Never swallow errors silently
- Use try/catch in async route handlers

### Code Quality
- One route file per resource (users.js, orders.js, etc.)
- Export express.Router() from each route file
- Mount routes in index.js with clear prefixes
- Use middleware for cross-cutting concerns (auth, logging)
- Keep index.js under 50 lines — it's just wiring

### Database
- Use connection pooling
- Handle connection errors gracefully
- Use migrations for schema changes
- Never use string concatenation for queries — use parameterized queries
- Close connections on process exit

### Monitoring
- /health endpoint is mandatory
- Log request duration for slow endpoint detection
- Use structured logging (JSON format)
- Track error rates per endpoint
