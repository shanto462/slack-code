// Ask a live Claude Code session which account it authenticated as.
// Costs nothing: it initialises the session and asks, without running a turn.
import { query } from '@anthropic-ai/claude-agent-sdk';

const execPath = process.argv[2] || undefined;

const options = { cwd: process.cwd(), permissionMode: 'plan' };
if (execPath) options.pathToClaudeCodeExecutable = execPath;

// Yield one message so the session initialises, then bail at init — before any
// inference happens, so nothing is billed.
async function* idle() {
  yield { type: 'user', message: { role: 'user', content: 'hi' }, parent_tool_use_id: null };
  await new Promise(() => {});
}

const q = query({ prompt: idle(), options });

const inited = new Promise((resolve, reject) => {
  (async () => {
    try {
      for await (const message of q) {
        if (message.type === 'system' && message.subtype === 'init') return resolve(message);
      }
      reject(new Error('stream ended before init'));
    } catch (error) {
      reject(error);
    }
  })();
});

const timeout = setTimeout(() => {
  console.log(JSON.stringify({ error: 'timed out waiting for init' }));
  process.exit(1);
}, 45_000);

try {
  await inited;
  const info = await q.accountInfo();
  clearTimeout(timeout);
  console.log(JSON.stringify(info));
} catch (error) {
  clearTimeout(timeout);
  console.log(JSON.stringify({ error: String(error?.message ?? error) }));
}
process.exit(0);
