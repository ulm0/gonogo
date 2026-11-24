// throwaway file for testing auto-review; closed unmerged
const { execSync } = require('node:child_process');

function run(userInput) {
  // runs whatever the caller sends
  return execSync('ls ' + userInput).toString();
}

module.exports = { run };
