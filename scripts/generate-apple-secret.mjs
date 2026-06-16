#!/usr/bin/env node
/**
 * Generates the Apple client secret JWT required by Supabase.
 * Run: node scripts/generate-apple-secret.mjs
 *
 * You need: Team ID, Key ID, bundle ID, and path to your .p8 file.
 */

import { readFileSync } from "fs";
import { createSign } from "crypto";

// --- Configure these ---
const TEAM_ID = process.env.APPLE_TEAM_ID || "REPLACE_WITH_TEAM_ID";
const KEY_ID = process.env.APPLE_KEY_ID || "REPLACE_WITH_KEY_ID";
const BUNDLE_ID = "com.nimaalikhani.Veckly"; // This is your client_id
const P8_PATH = process.env.APPLE_P8_PATH || "REPLACE_WITH_PATH_TO_.p8";
// -----------------------

function base64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

const now = Math.floor(Date.now() / 1000);
const exp = now + 15777000; // 6 months

const header = base64url(Buffer.from(JSON.stringify({ alg: "ES256", kid: KEY_ID })));
const payload = base64url(
  Buffer.from(
    JSON.stringify({
      iss: TEAM_ID,
      iat: now,
      exp,
      aud: "https://appleid.apple.com",
      sub: BUNDLE_ID,
    })
  )
);

const signingInput = `${header}.${payload}`;

const privateKey = readFileSync(P8_PATH, "utf8");
const sign = createSign("SHA256");
sign.update(signingInput);
sign.end();
const signature = base64url(sign.sign({ key: privateKey, dsaEncoding: "ieee-p1363" }));

const jwt = `${signingInput}.${signature}`;

console.log("\n=== Apple Client Secret JWT ===");
console.log(jwt);
console.log("\nKopieras in i Supabase → Authentication → Providers → Apple → Secret Key");
console.log(`\nGiltigt till: ${new Date(exp * 1000).toLocaleDateString("sv-SE")} (6 månader)`);
