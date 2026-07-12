#!/usr/bin/env sh
set -eu

# Prove that host port overrides never leak into the container network
# contract. Compose must keep api:50700 and web:50701 internally.
# Use non-canonical host ports only to prove host remapping does not alter
# the fixed container contract. These are test values, never launch defaults.
API_PORT=50800 WEB_PORT=50801 docker compose config --format json | bun -e '
const compose = await Bun.stdin.json();
const api = compose.services.api;
const web = compose.services.web;
const storage = compose.services.seaweedfs;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(api.ports.some((port) => port.published === "50800" && port.target === 50700), "API test host mapping must be 50800:50700");
assert(api.environment.API_PORT === "50700", "API process must listen on 50700");
assert(api.healthcheck.test.join(" ").includes("127.0.0.1:50700/api/health"), "API healthcheck must use 50700");

assert(web.ports.some((port) => port.published === "50801" && port.target === 50701), "Web test host mapping must be 50801:50701");
assert(web.environment.API_URL === "http://api:50700", "Web must reach api:50700");
assert(web.environment.PORT === "50701", "Web process must listen on 50701");
assert(web.healthcheck.test.join(" ").includes("127.0.0.1:50701"), "Web healthcheck must use 50701");
assert(storage.ports.some((port) => port.published === "50702" && port.target === 8333), "Storage S3 mapping must be 50702:8333");
assert(storage.ports.some((port) => port.published === "50703" && port.target === 8888), "Storage UI mapping must be 50703:8888");

console.log("Compose port contract passed: host overrides -> api:50700, web:50701");
'

API_PORT=50800 WEB_PORT=50801 docker compose -f docker-compose.dev.yml.example config --format json | bun -e '
const compose = await Bun.stdin.json();
const api = compose.services.api;
const web = compose.services.web;
const storage = compose.services.seaweedfs;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(api.ports.some((port) => port.published === "50800" && port.target === 50700), "Dev API test host mapping must be 50800:50700");
assert(api.environment.API_PORT === "50700", "Dev API process must listen on 50700");
assert(web.ports.some((port) => port.published === "50801" && port.target === 50701), "Dev web test host mapping must be 50801:50701");
assert(web.environment.API_URL === "http://api:50700", "Dev web must reach api:50700");
assert(web.environment.PORT === "50701", "Dev web process must listen on 50701");
assert(storage.ports.some((port) => port.published === "50702" && port.target === 8333), "Dev storage S3 mapping must be 50702:8333");
assert(storage.ports.some((port) => port.published === "50703" && port.target === 8888), "Dev storage UI mapping must be 50703:8888");

console.log("Dev Compose port contract passed: host overrides -> api:50700, web:50701");
'
