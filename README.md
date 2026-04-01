# Wolverine Node.js

Self-healing Node.js backend powered by AI. Wolverine watches your server process, catches crashes, and automatically repairs the source code using OpenAI — then restarts.

Inspired by [claw-code](https://github.com/instructkr/claw-code) and the concept of AI-powered developer tools.

## How It Works

```
Your Server Crashes → Wolverine Catches Error → AI Analyzes & Generates Fix → Patch Applied → Server Restarts
```

1. **Error Detection**: Wolverine runs your Node.js script as a child process and captures stderr
2. **Error Parsing**: Extracts the file path, line number, and error message from the stack trace
3. **AI Repair**: Sends the error context + source code to OpenAI, which returns a minimal fix
4. **Patch Application**: Applies the fix to the source file (with automatic backup/rollback)
5. **Restart**: Restarts the server process with the patched code

## Quick Start

```bash
# 1. Clone the repo
git clone https://github.com/YOUR_USERNAME/wolverine-nodejs.git
cd wolverine-nodejs

# 2. Install dependencies
npm install

# 3. Configure your API key
cp .env.example .env.local
# Edit .env.local and add your OPENAI_API_KEY

# 4. Run the demo (buggy server that wolverine will fix)
npm run demo
```

## Usage

### CLI

```bash
# Run any Node.js script with wolverine watching
node bin/wolverine.js your-server.js

# Or use npx after npm link
wolverine your-server.js
```

### Programmatic

```javascript
const { WolverineRunner } = require("wolverine-nodejs");

const runner = new WolverineRunner("./server.js", {
  cwd: __dirname,
});

runner.start();

// Graceful shutdown
process.on("SIGINT", () => runner.stop());
```

### Single Error Repair

```javascript
const { heal } = require("wolverine-nodejs");

const result = await heal({
  stderr: "ReferenceError: userData is not defined\n    at ...",
  cwd: "/path/to/project",
});

console.log(result.healed);      // true/false
console.log(result.explanation);  // "The variable was misspelled..."
```

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `OPENAI_API_KEY` | (required) | Your OpenAI API key |
| `OPENAI_MODEL` | `gpt-4o` | OpenAI model to use |
| `WOLVERINE_MAX_RETRIES` | `3` | Max repair attempts before giving up |
| `PORT` | `3000` | Port for demo server |

## Project Structure

```
wolverine-nodejs/
├── bin/
│   └── wolverine.js        # CLI entry point
├── src/
│   ├── index.js             # Public API
│   └── core/
│       ├── ai-client.js     # OpenAI integration
│       ├── error-parser.js  # Stack trace parsing
│       ├── patcher.js       # File patching with backup/rollback
│       ├── runner.js        # Process manager
│       └── wolverine.js     # Healing engine orchestrator
├── examples/
│   └── buggy-server.js      # Demo server with intentional bug
├── .env.example             # Environment template
└── package.json
```

## How the Demo Works

The `examples/buggy-server.js` has an intentional bug — it references `userData` instead of `users`. When you run `npm run demo`:

1. Wolverine starts the buggy server
2. The server crashes with `ReferenceError: userData is not defined`
3. Wolverine sends the error + source to OpenAI
4. OpenAI responds with the fix: change `userData` to `users`
5. Wolverine patches the file and restarts
6. Server runs successfully on port 3000

## Security Notes

See the Security Audit section below for important considerations before using in production.

## License

MIT
