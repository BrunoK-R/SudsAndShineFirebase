import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const firebaseRoot = path.resolve(scriptDirectory, "..");
const appRoot = process.env.SUDS_APP_REPO ?
  path.resolve(process.env.SUDS_APP_REPO) :
  path.resolve(firebaseRoot, "../App");
const websiteRoot = process.env.SUDS_WEBSITE_REPO ?
  path.resolve(process.env.SUDS_WEBSITE_REPO) :
  path.resolve(firebaseRoot, "../Website/sudsandshine");
const mobileConfigPath = path.join(
  appRoot,
  "data/src/commonMain/kotlin/com/sudsmobile/data/booking/FirebaseFunctionsConfig.kt",
);
const functionsIndexPath = path.join(firebaseRoot, "functions/index.js");
const websiteFunctionsPath = path.join(websiteRoot, "src/integrations/firebase/functions.ts");
const websiteAuthPath = path.join(websiteRoot, "src/integrations/firebase/auth.ts");

for (const requiredPath of [mobileConfigPath, websiteFunctionsPath, websiteAuthPath, functionsIndexPath]) {
  if (!fs.existsSync(requiredPath)) {
    console.error(`Required contract file not found: ${requiredPath}`);
    process.exit(1);
  }
}

const mobileConfig = fs.readFileSync(mobileConfigPath, "utf8");
const websiteConsumers = [websiteFunctionsPath, websiteAuthPath]
  .map((consumerPath) => fs.readFileSync(consumerPath, "utf8"))
  .join("\n");
const functionsIndex = fs.readFileSync(functionsIndexPath, "utf8");
const mobileCallables = new Set();
const websiteCallables = new Set();
const deployedCallables = new Set();

for (const match of mobileConfig.matchAll(/functionUrl\("([A-Za-z][A-Za-z0-9_]*)"\)/g)) {
  mobileCallables.add(match[1]);
}
for (const match of mobileConfig.matchAll(/cloudfunctions\.net\/([A-Za-z][A-Za-z0-9_]*)/g)) {
  mobileCallables.add(match[1]);
}
for (const match of websiteConsumers.matchAll(/firebaseFunctions\s*,\s*"([A-Za-z][A-Za-z0-9_]*)"/g)) {
  websiteCallables.add(match[1]);
}
for (const match of functionsIndex.matchAll(/exports\.([A-Za-z][A-Za-z0-9_]*)\s*=\s*onCall\b/g)) {
  deployedCallables.add(match[1]);
}

const missingCallables = [
  ...[...mobileCallables].map((functionName) => ({consumer: "mobile", functionName})),
  ...[...websiteCallables].map((functionName) => ({consumer: "website", functionName})),
]
  .filter(({functionName}) => !deployedCallables.has(functionName))
  .sort((left, right) => left.functionName.localeCompare(right.functionName));

if (missingCallables.length > 0) {
  console.error("The mobile app references callable functions that are missing from FirebaseSuds:");
  for (const {consumer, functionName} of missingCallables) console.error(`- ${functionName} (${consumer})`);
  process.exit(1);
}

console.log(
  `Consumer function contract OK: ${mobileCallables.size} mobile and ` +
    `${websiteCallables.size} website callables are exported by FirebaseSuds.`,
);
