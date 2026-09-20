const [major] = process.versions.node.split(".").map(Number);

if (major !== 24) {
  console.error(`GetDone CI requires Node 24.x; received ${process.versions.node}`);
  process.exit(1);
}

const npmVersion = process.env.npm_config_user_agent?.match(/npm\/([^\s]+)/)?.[1];
if (!npmVersion) {
  console.error("Unable to determine npm runtime version.");
  process.exit(1);
}

console.log(`Runtime verified: node=${process.versions.node} npm=${npmVersion}`);
