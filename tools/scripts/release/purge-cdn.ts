// Moves jsDelivr to a continuous package's new release.
//
// Ghost loads each public app from a jsDelivr version alias (`~major.minor`).
// jsDelivr resolves an alias to a version once and caches the answer for twelve
// hours, so a new patch reaches sites when the alias is purged or when that
// cache expires. A purge makes jsDelivr resolve the alias again from what npm
// lists at that moment, and npm lists a version minutes after `pnpm publish`
// returns. A purge sent straight after the publish therefore makes jsDelivr
// cache the previous version for another twelve hours.
//
// So the work is split in two. The publish job records what it released
// (`record`). The "Purge CDN" workflow runs after the CI run, so the wait
// doesn't hold that run up: it waits for npm to list each release, purges the
// release's URLs and checks that jsDelivr now serves it (`purge`).
//
// Usage:
//   node purge-cdn.ts record --package <name> --version <version> --cdn-paths <paths> <file>
//   node purge-cdn.ts purge <dir>
//
// This file imports nothing outside Node, because the purge job installs no
// dependencies.

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';

/**
 * Stands in for a package's `major.minor` in the URLs build-publish-matrix.ts
 * hands the publish job, which only learns the version when it publishes.
 */
export const MINOR_PLACEHOLDER = 'CURRENT_MINOR';

const CDN_ORIGIN = 'https://cdn.jsdelivr.net/';
const PURGE_ORIGIN = 'https://purge.jsdelivr.net/';

// npm has taken up to five minutes to list a version it accepted.
const NPM_POLL_MS = 10_000;
const NPM_POLLS = 90;

const PURGE_ATTEMPTS = 6;
/** How long a purge is given to reach jsDelivr's caches before the URL is checked. */
const PURGE_SETTLE_MS = 5_000;
const PURGE_RETRY_MS = 20_000;

/** A release of a package Ghost serves from jsDelivr, and the alias URLs that must move to it. */
export interface CdnRelease {
  package: string;
  version: string;
  urls: string[];
}

/** What the purge needs from the outside world, so tests can stand in for npm and jsDelivr. */
export interface Network {
  fetch: (
    url: string,
    init?: { method?: string; headers?: Record<string, string> },
  ) => Promise<Response>;
  sleep: (ms: number) => Promise<unknown>;
}

const NETWORK: Network = { fetch, sleep };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The three numbers of a stable version, or null for anything else, such as a prerelease. */
function stableParts(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/**
 * Whether the version jsDelivr served is the release or a later one. A later
 * one counts because a second release can land while the first is still
 * waiting for npm, and the alias then rightly skips the first.
 */
function servesRelease(served: string | null, version: string): boolean {
  if (served === null) {
    return false;
  }
  const servedParts = stableParts(served);
  const releaseParts = stableParts(version);
  if (!servedParts || !releaseParts) {
    return served === version;
  }
  const [servedMajor, servedMinor, servedPatch] = servedParts;
  const [major, minor, patch] = releaseParts;
  if (servedMajor !== major) {
    return servedMajor > major;
  }
  if (servedMinor !== minor) {
    return servedMinor > minor;
  }
  return servedPatch >= patch;
}

/**
 * The release the publish job hands to the purge.
 *
 * @param cdnPaths - newline-delimited URLs from build-publish-matrix.ts, with
 *   MINOR_PLACEHOLDER where the version's `major.minor` goes
 */
export function cdnRelease(packageName: string, version: string, cdnPaths: string): CdnRelease {
  const parts = stableParts(version);
  if (!parts) {
    throw new Error(`${packageName}@${version} is not a stable version, so it has no CDN alias`);
  }
  const minor = `${parts[0]}.${parts[1]}`;
  const urls = cdnPaths
    .split('\n')
    .map((url) => url.trim())
    .filter(Boolean)
    .map((url) => url.replaceAll(MINOR_PLACEHOLDER, minor));
  return parseCdnRelease({ package: packageName, version, urls });
}

/**
 * Reads a recorded release, refusing one this script can't act on. The record
 * crosses from one workflow run to another, so its shape is checked here rather
 * than assumed.
 */
function parseCdnRelease(value: unknown): CdnRelease {
  if (!isRecord(value)) {
    throw new Error('A CDN release must be an object');
  }
  const { package: packageName, version, urls } = value;
  if (typeof packageName !== 'string' || !packageName) {
    throw new Error('A CDN release must name its package');
  }
  if (typeof version !== 'string' || !version) {
    throw new Error(`The CDN release of ${packageName} must name its version`);
  }
  if (!Array.isArray(urls) || urls.length === 0) {
    throw new Error(`The CDN release of ${packageName}@${version} has no URLs to purge`);
  }
  const checked: string[] = [];
  for (const url of urls) {
    if (typeof url !== 'string' || !url.startsWith(CDN_ORIGIN)) {
      throw new Error(
        `${packageName}@${version} asks to purge "${String(url)}", which jsDelivr doesn't serve`,
      );
    }
    checked.push(url);
  }
  return { package: packageName, version, urls: checked };
}

/** Every release recorded under a folder, at any depth: each downloaded artifact is a folder of its own. */
export async function readCdnReleases(dir: string): Promise<CdnRelease[]> {
  const files = (await readdir(dir, { recursive: true })).filter((file) => file.endsWith('.json'));
  const releases: CdnRelease[] = [];
  for (const file of files.sort()) {
    releases.push(parseCdnRelease(JSON.parse(await readFile(join(dir, file), 'utf8'))));
  }
  return releases;
}

/** Whether npm lists the release: the state jsDelivr resolves an alias from. */
async function npmLists(release: CdnRelease, network: Network): Promise<boolean> {
  const response = await network.fetch(
    `https://registry.npmjs.org/${encodeURIComponent(release.package)}`,
    // The abbreviated document: every version, without each one's metadata.
    { headers: { accept: 'application/vnd.npm.install-v1+json' } },
  );
  if (!response.ok) {
    return false;
  }
  const body: unknown = await response.json();
  return isRecord(body) && isRecord(body.versions) && release.version in body.versions;
}

/** Waits until npm lists the release, and fails if it never does. */
async function waitForNpm(release: CdnRelease, network: Network = NETWORK): Promise<void> {
  for (let poll = 1; poll <= NPM_POLLS; poll++) {
    let listed = false;
    try {
      listed = await npmLists(release, network);
    } catch (error) {
      console.log(`Couldn't ask npm about ${release.package}: ${messageOf(error)}`);
    }
    if (listed) {
      console.log(`npm lists ${release.package}@${release.version}`);
      return;
    }
    await network.sleep(NPM_POLL_MS);
  }
  throw new Error(`npm never listed ${release.package}@${release.version}`);
}

/**
 * Asks jsDelivr to drop its cached copies of a URL. Returns whether jsDelivr
 * finished the purge, and throws when jsDelivr refuses to purge the URL again
 * so soon, which retrying can't fix.
 */
async function purge(url: string, network: Network): Promise<boolean> {
  const response = await network.fetch(url.replace(CDN_ORIGIN, PURGE_ORIGIN));
  if (!response.ok) {
    console.log(`jsDelivr answered the purge of ${url} with ${response.status}`);
    return false;
  }
  const body: unknown = await response.json();
  if (!isRecord(body)) {
    return false;
  }
  if (isRecord(body.paths)) {
    for (const [path, state] of Object.entries(body.paths)) {
      if (isRecord(state) && state.throttled === true) {
        throw new Error(`jsDelivr throttled the purge of ${path}`);
      }
    }
  }
  return body.status === undefined || body.status === 'finished';
}

/** What jsDelivr serves at a URL right now: the package version it came from, and the file's ETag. */
interface Served {
  version: string | null;
  etag: string | null;
}

async function servedAt(url: string, network: Network): Promise<Served> {
  const response = await network.fetch(url, { method: 'HEAD' });
  return { version: response.headers.get('x-jsd-version'), etag: response.headers.get('etag') };
}

/** The URL of the same file in one exact version: `portal@~2.72/…` becomes `portal@2.72.35/…`. */
function pinnedUrl(aliasUrl: string, version: string): string {
  return aliasUrl.replace(/@~[^/]+\//, `@${version}/`);
}

/**
 * Whether an alias URL serves the release. The version jsDelivr reports is
 * enough when it is the release or later. When it is earlier the file is
 * compared instead: jsDelivr keeps reporting the version a file last changed
 * in, so a file the release didn't change reports an earlier version for good.
 */
async function servesReleaseAt(
  aliasUrl: string,
  alias: Served,
  version: string,
  network: Network,
): Promise<boolean> {
  if (servesRelease(alias.version, version)) {
    return true;
  }
  const pinned = pinnedUrl(aliasUrl, version);
  if (pinned === aliasUrl || alias.etag === null) {
    return false;
  }
  const release = await servedAt(pinned, network);
  return release.etag === alias.etag;
}

/**
 * Purges one alias URL until jsDelivr serves the release from it. One purge is
 * usually enough. It is repeated because the request that checks the URL makes
 * jsDelivr resolve the alias again, and an answer that is still the previous
 * version would otherwise stay cached for twelve hours.
 */
async function purgeUntilServed(
  url: string,
  version: string,
  network: Network = NETWORK,
): Promise<void> {
  let reported = 'no version';
  for (let attempt = 1; attempt <= PURGE_ATTEMPTS; attempt++) {
    if (await purge(url, network)) {
      await network.sleep(PURGE_SETTLE_MS);
      const alias = await servedAt(url, network);
      reported = alias.version ?? 'no version';
      if (await servesReleaseAt(url, alias, version, network)) {
        console.log(`${url} serves ${version} (jsDelivr reports ${reported})`);
        return;
      }
      console.log(`${url} still serves ${reported} after purge ${attempt}`);
    }
    await network.sleep(PURGE_RETRY_MS);
  }
  throw new Error(`${url} serves ${reported}, not ${version}, after ${PURGE_ATTEMPTS} purges`);
}

/** Moves every alias URL of a release to it, once npm lists the release. */
export async function purgeRelease(release: CdnRelease, network: Network = NETWORK): Promise<void> {
  await waitForNpm(release, network);
  for (const url of release.urls) {
    await purgeUntilServed(url, release.version, network);
  }
}

async function record(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      package: { type: 'string' },
      version: { type: 'string' },
      'cdn-paths': { type: 'string' },
    },
    allowPositionals: true,
  });
  const [file] = positionals;
  if (!values.package || !values.version || !values['cdn-paths'] || !file) {
    throw new Error('record needs --package, --version, --cdn-paths and a file to write');
  }
  const release = cdnRelease(values.package, values.version, values['cdn-paths']);
  await mkdir(dirname(resolve(file)), { recursive: true });
  await writeFile(file, `${JSON.stringify(release, null, 2)}\n`);
  console.log(`Recorded ${release.package}@${release.version}: ${release.urls.join(', ')}`);
}

async function purgeAll(args: string[]): Promise<void> {
  const [dir] = args;
  if (!dir) {
    throw new Error('purge needs the folder the releases were recorded in');
  }
  const releases = await readCdnReleases(dir);
  if (releases.length === 0) {
    console.log(`No CDN releases recorded in ${dir}`);
    return;
  }
  // Each release waits on npm for minutes, so they wait side by side.
  const results = await Promise.allSettled(releases.map((release) => purgeRelease(release)));
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [messageOf(result.reason)] : [],
  );
  if (failures.length > 0) {
    throw new Error(failures.join('\n'));
  }
  console.log(
    `jsDelivr serves ${releases.map((release) => `${release.package}@${release.version}`).join(', ')}`,
  );
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'record') {
    await record(args);
  } else if (command === 'purge') {
    await purgeAll(args);
  } else {
    throw new Error('Usage: purge-cdn.ts record|purge …');
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(messageOf(error));
    process.exit(1);
  }
}
