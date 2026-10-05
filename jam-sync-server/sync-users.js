#!/usr/bin/env node
// Syncs the sync server's known users with Navidrome's user list: adds new
// users, follows renames and spelling changes, and with --prune removes
// users that are no longer in Navidrome (with their friends and invites).
//
// Run it inside the container, as a Navidrome admin:
//   docker exec -it aonsoku node /opt/jam-sync-server/sync-users.js [--prune]
//
// It asks for the admin's username and password (the password isn't shown
// as you type) and sends them once to the running sync server, which signs
// in to Navidrome with them to read the user list. Nothing is saved.
//
// Users are still learned from logins as well; this only brings everyone
// in at once.

const readline = require('readline');

const SERVER = process.env.SYNC_SERVER_ADMIN_URL || 'http://127.0.0.1:7548';
const prune = process.argv.includes('--prune');

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    if (hidden) {
      // Print the question, then nothing for what's typed.
      rl._writeToOutput = (text) => {
        if (text.includes(question)) process.stdout.write(text);
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

async function main() {
  const username = await ask('Navidrome admin username: ');
  const password = await ask('Password: ', { hidden: true });
  if (!username || !password) {
    console.error('A username and password are needed.');
    process.exit(1);
  }

  let response;
  try {
    response = await fetch(`${SERVER}/admin/sync-users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, prune }),
    });
  } catch (err) {
    console.error(`Couldn't reach the sync server at ${SERVER}: ${err.message}`);
    console.error('Run this inside the Aonsoku container (docker exec -it aonsoku ...).');
    process.exit(1);
  }
  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    const messages = {
      unauthorized: 'Navidrome refused that username and password.',
      not_admin: 'That account is not a Navidrome admin.',
      sync_not_configured: 'The sync server has no NAVIDROME_URL (or SERVER_URL) set.',
      navidrome_unreachable: "The sync server couldn't reach Navidrome.",
    };
    console.error(messages[result.error] || `Failed: ${result.error || response.status}`);
    process.exit(1);
  }

  const show = (label, items) => {
    console.log(`${label}: ${items.length}`);
    for (const item of items) console.log(`  ${item}`);
  };
  console.log(`Navidrome has ${result.total} users.`);
  show('Added', result.added);
  show('Renamed', result.renamed);
  show('Updated', result.updated);
  if (prune) show('Removed', result.removed);
  else console.log('Users no longer in Navidrome were kept (add --prune to remove them).');
}

main();
