#!/usr/bin/env node
const MIN_NODE_MAJOR = 24;

if (Number(process.versions.node.split('.')[0]) < MIN_NODE_MAJOR) {
  process.stderr.write(`gonogo needs Node ${MIN_NODE_MAJOR} or newer (this is ${process.versions.node}).\n`);
  process.exit(1);
} else {
  // The pty library is loaded when cli.js is imported, and its loader throws one long, helpful message (platform package
  // missing, --omit=optional, Alpine, a node_modules copied between systems): print it as one line, not as a stack.
  try {
    const { main } = await import('../dist/server/cli.js');
    await main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write('gonogo: ' + (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').trim() + '\n');
    if (process.env.GONOGO_LOG_LEVEL === 'debug' && e instanceof Error) process.stderr.write(String(e.stack) + '\n');
    process.exit(1);
  }
}
