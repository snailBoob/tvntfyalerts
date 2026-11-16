#!/usr/bin/env bash
set -euo pipefail
image=${1:?Usage: bash scripts/docker-smoke.sh IMAGE}
name="tvntfy-smoke-${RANDOM}-$$"
network="$name-net"
volume="$name-state"
cleanup() {
  docker rm -f "$name" "$name-ntfy" >/dev/null 2>&1 || true
  docker volume rm "$volume" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
}
trap cleanup EXIT
# No external traffic: synthetic cookies must never reach TradingView.
docker network create --internal "$network" >/dev/null
docker volume create "$volume" >/dev/null
docker run -d --name "$name-ntfy" --network "$network" --network-alias ntfy \
  "$image" node --input-type=module -e '
    import {createServer} from "node:http";
    let starts=0;
    createServer(async(req,res)=>{
      if(req.method==="GET") {res.end(JSON.stringify({starts})); return;}
      let body=""; for await(const chunk of req) body+=chunk;
      const data=JSON.parse(body);
      if(data.title==="TV ntfy started") starts++;
      res.end(JSON.stringify({id:"fixture",event:"message"}));
    }).listen(8080,"0.0.0.0");' >/dev/null
docker exec -i "$name-ntfy" node --input-type=module <<'JS'
import {setTimeout as delay} from 'node:timers/promises';
let ready=false;
for(let i=0;i<50;i++) {
  try {if((await fetch('http://localhost:8080')).ok) {ready=true;break;}} catch {}
  await delay(200);
}
if(!ready) throw new Error('Fixture server did not start');
JS
start_app() {
  docker run -d --name "$name" --network "$network" \
    -e NTFY_URL=http://ntfy:8080 -e NTFY_TOPIC=smoke \
    -e PUBLIC_URL=http://localhost:3080 -v "$volume:/state" "$image" >/dev/null
}
check_app() {
  docker exec -i -e EXPECTED_STARTS="$1" "$name" node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
let ready=false;
for(let i=0;i<30;i++) {
  try {if((await fetch('http://localhost:3080/api/status')).ok) {ready=true;break;}} catch {}
  await delay(200);
}
assert.ok(ready,'settings API must become available');
assert.notEqual(process.getuid(),0,'runtime must be non-root');
for(const path of ['/','/style.css','/client.js','/favicon.ico','/apple-touch-icon.png','/tradingview.svg','/ntfy.svg']) {
  const res=await fetch('http://localhost:3080'+path);
  assert.equal(res.status,200,path);
  assert.ok((await res.arrayBuffer()).byteLength>0,path);
}
let received=false;
for(let i=0;i<50;i++) {
  if((await (await fetch('http://ntfy:8080')).json()).starts>=Number(process.env.EXPECTED_STARTS)) {received=true;break;}
  await delay(200);
}
assert.ok(received,'startup notification must arrive');
JS
}
start_app
check_app 1
docker exec -i "$name" node --input-type=module <<'JS'
import {saveCookies,writePrivateJson} from '/app/settings.mjs';
await saveCookies('.env',{sessionid:'synthetic-cookie',sessionid_sign:'synthetic-signature'});
await writePrivateJson('data/seen.json',['synthetic-trigger']);
JS
docker stop -t 20 "$name" >/dev/null
docker rm "$name" >/dev/null
start_app
check_app 2
docker exec -i "$name" node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import {stat} from 'node:fs/promises';
import {Delivery} from '/app/notifications.mjs';
process.loadEnvFile('.env');
assert.equal(process.env.TV_SESSIONID,'synthetic-cookie');
assert.equal(process.env.TV_SESSIONID_SIGN,'synthetic-signature');
assert.equal((await stat('.env')).mode & 0o777,0o600);
const delivery=new Delivery({statePath:'data/seen.json'});
await delivery.load();
assert.ok(delivery.seen.has('synthetic-trigger'));
JS
echo 'Container smoke checks passed: non-root startup, static assets, ntfy delivery, persistent cookies and deduplication.'
